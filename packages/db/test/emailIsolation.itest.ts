// emailIsolation.itest.ts — the MANDATORY cross-tenant isolation proof for the M12 email subsystem
// (email-planning/13 P0 §7, 14 §6, the security mandate). On a real Postgres 16 (Testcontainers by default,
// or an external server via ITEST_DATABASE_URL — see itestDb.ts). Run in its OWN process (the db client is a
// module singleton): `bun test ./packages/db/test/emailIsolation.itest.ts`.
//
// Proves, for the net-new email tables — sending_domain + oauth_connect_state (tenant-scoped); and
// mailbox_integration + email_event + email_thread + email_message (workspace-scoped) — that:
//   (1) the non-BYPASSRLS leadwolf_app role with the WRONG tenant/workspace GUC sees ZERO of the other
//       tenant's rows (RLS USING, fail-closed via NULLIF), and the RIGHT GUC sees its own;
//   (2) that role cannot INSERT a row into another tenant/workspace (RLS WITH CHECK blocks it);
//   (3) the repositories (which run under withTenantTx) return only the caller's own rows — the end-to-end
//       proof of withTenantTx + RLS together — and the mailbox read NEVER carries the encrypted credential;
//   (4) the per-tenant send-quota no-overdraft CHECK + the sendQuotaRepository FOR UPDATE lock make an
//       over-quota send impossible (15 §A.6, known-gap #3).
// NOTE: oauth_connect_state is RLS ENABLE (not FORCE) so the session-less OAuth callback can read it on the
// owner connection (rls/email.sql §oauth_connect_state) — but leadwolf_app is NOT the table owner, so the
// isolation proof below still holds for the app role exactly like a FORCE table.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let app: ReturnType<typeof postgres>;
let dbmod: DbModule;

let tenantA = "";
let wsA = "";
let ownerA = "";
let domainA = "";
let mailboxA = "";

let tenantB = "";
let wsB = "";
let ownerB = "";
let domainB = "";
let mailboxB = "";

// M12 P1/P3 net-new: the OAuth handshake store + the conversation/message store.
let connectStateA = "";
let threadA = "";
let threadB = "";

interface Seeded {
  tenantId: string;
  wsId: string;
  ownerId: string;
}

async function seedTenant(slug: string): Promise<Seeded> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const tenantId = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  const ownerId = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantId}, ${ownerId}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, ${slug}, ${slug}, true, ${ownerId}) RETURNING id`;
  const wsId = (w as { id: string }).id;
  return { tenantId, wsId, ownerId };
}

beforeAll(async () => {
  dbHandle = await startItestDb("emailIsolation");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  app = postgres(dbHandle.appUrl, { max: 2, onnotice: () => {} });

  ({ tenantId: tenantA, wsId: wsA, ownerId: ownerA } = await seedTenant("acme"));
  ({ tenantId: tenantB, wsId: wsB, ownerId: ownerB } = await seedTenant("globex"));

  // env is set above, BEFORE the db singleton loads.
  dbmod = await import("@leadwolf/db");

  // Fixture rows for each tenant — seeded via the privileged admin connection (bypasses RLS for setup).
  const [da] = await admin`
    INSERT INTO sending_domain (tenant_id, domain, status, spf_state, dkim_state, dmarc_state)
    VALUES (${tenantA}, 'mail.acme.com', 'verified', 'pass', 'pass', 'pass') RETURNING id`;
  domainA = (da as { id: string }).id;
  const [dbn] = await admin`
    INSERT INTO sending_domain (tenant_id, domain) VALUES (${tenantB}, 'mail.globex.com') RETURNING id`;
  domainB = (dbn as { id: string }).id;

  const [ma] = await admin`
    INSERT INTO mailbox_integration
      (tenant_id, workspace_id, owner_user_id, provider, address, status, oauth_token_enc)
    VALUES (${tenantA}, ${wsA}, ${ownerA}, 'google', 'sdr@acme.com', 'connected', '\\xdeadbeef'::bytea)
    RETURNING id`;
  mailboxA = (ma as { id: string }).id;
  const [mb] = await admin`
    INSERT INTO mailbox_integration (tenant_id, workspace_id, owner_user_id, provider, address)
    VALUES (${tenantB}, ${wsB}, ${ownerB}, 'microsoft', 'sdr@globex.com') RETURNING id`;
  mailboxB = (mb as { id: string }).id;

  await admin`
    INSERT INTO email_event (tenant_id, workspace_id, event_type, occurred_at)
    VALUES (${tenantA}, ${wsA}, 'open', now())`;
  await admin`
    INSERT INTO email_event (tenant_id, workspace_id, event_type, occurred_at)
    VALUES (${tenantB}, ${wsB}, 'open', now())`;

  // oauth_connect_state — tenant-scoped (P1 OAuth handshake store). The pkce_verifier_enc is the encrypted
  // canary; a cross-tenant read must surface NONE of it.
  const [csa] = await admin`
    INSERT INTO oauth_connect_state
      (tenant_id, workspace_id, user_id, provider, state_token, pkce_verifier_enc, expires_at)
    VALUES (${tenantA}, ${wsA}, ${ownerA}, 'google', 'state-token-acme',
            '\\xc0ffee'::bytea, now() + interval '10 minutes')
    RETURNING id`;
  connectStateA = (csa as { id: string }).id;
  await admin`
    INSERT INTO oauth_connect_state
      (tenant_id, workspace_id, user_id, provider, state_token, pkce_verifier_enc, expires_at)
    VALUES (${tenantB}, ${wsB}, ${ownerB}, 'google', 'state-token-globex',
            '\\xc0ffee'::bytea, now() + interval '10 minutes')`;

  // email_thread — workspace-scoped (P3 inbox): one conversation per workspace.
  const [tha] = await admin`
    INSERT INTO email_thread (tenant_id, workspace_id, owner_user_id, mailbox_integration_id, status)
    VALUES (${tenantA}, ${wsA}, ${ownerA}, ${mailboxA}, 'open') RETURNING id`;
  threadA = (tha as { id: string }).id;
  const [thb] = await admin`
    INSERT INTO email_thread (tenant_id, workspace_id, owner_user_id, mailbox_integration_id, status)
    VALUES (${tenantB}, ${wsB}, ${ownerB}, ${mailboxB}, 'open') RETURNING id`;
  threadB = (thb as { id: string }).id;

  // email_message — workspace-scoped: an outbound message in each thread. body_enc is the PII canary (D7) the
  // cross-workspace isolation must never surface.
  await admin`
    INSERT INTO email_message
      (tenant_id, workspace_id, thread_id, mailbox_integration_id, direction, from_addr, body_enc, occurred_at)
    VALUES (${tenantA}, ${wsA}, ${threadA}, ${mailboxA}, 'outbound', 'sdr@acme.com', '\\xbadc0de'::bytea, now())`;
  await admin`
    INSERT INTO email_message
      (tenant_id, workspace_id, thread_id, mailbox_integration_id, direction, from_addr, occurred_at)
    VALUES (${tenantB}, ${wsB}, ${threadB}, ${mailboxB}, 'outbound', 'sdr@globex.com', now())`;
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await app?.end();
  await admin?.end();
  await dbHandle?.stop();
});

describe("M12 email cross-tenant isolation (P0)", () => {
  test("sending_domain (tenant-scoped): wrong tenant GUC sees zero; right sees its own", async () => {
    const wrong = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantB}, true)`;
      const [r] = await tx`SELECT count(*)::int AS n FROM sending_domain WHERE id = ${domainA}`;
      return (r as { n: number }).n;
    });
    expect(wrong).toBe(0);

    const right = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantA}, true)`;
      const [r] = await tx`SELECT count(*)::int AS n FROM sending_domain WHERE id = ${domainA}`;
      return (r as { n: number }).n;
    });
    expect(right).toBe(1);
  });

  test("sending_domain: tenant B cannot INSERT a domain for tenant A (RLS WITH CHECK)", async () => {
    let blocked = false;
    try {
      await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantB}, true)`;
        await tx`INSERT INTO sending_domain (tenant_id, domain) VALUES (${tenantA}, 'evil-cross.com')`;
      });
    } catch {
      blocked = true;
    }
    expect(blocked).toBe(true);
    // And no such row leaked in (asserted with the privileged connection).
    const [r] =
      await admin`SELECT count(*)::int AS n FROM sending_domain WHERE domain = 'evil-cross.com'`;
    expect((r as { n: number }).n).toBe(0);
  });

  test("mailbox_integration (workspace-scoped): wrong workspace GUC sees zero; right sees its own", async () => {
    const wrong = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_workspace_id', ${wsB}, true)`;
      const [r] =
        await tx`SELECT count(*)::int AS n FROM mailbox_integration WHERE id = ${mailboxA}`;
      return (r as { n: number }).n;
    });
    expect(wrong).toBe(0);

    const right = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_workspace_id', ${wsA}, true)`;
      const [r] =
        await tx`SELECT count(*)::int AS n FROM mailbox_integration WHERE id = ${mailboxA}`;
      return (r as { n: number }).n;
    });
    expect(right).toBe(1);
  });

  test("email_event (workspace-scoped): wrong workspace GUC sees zero of the other workspace's events", async () => {
    const wrong = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_workspace_id', ${wsB}, true)`;
      const [r] = await tx`SELECT count(*)::int AS n FROM email_event WHERE tenant_id = ${tenantA}`;
      return (r as { n: number }).n;
    });
    expect(wrong).toBe(0);
  });

  test("oauth_connect_state (tenant-scoped): wrong tenant GUC sees zero; right sees its own", async () => {
    const wrong = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantB}, true)`;
      const [r] =
        await tx`SELECT count(*)::int AS n FROM oauth_connect_state WHERE id = ${connectStateA}`;
      return (r as { n: number }).n;
    });
    expect(wrong).toBe(0);

    const right = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantA}, true)`;
      const [r] =
        await tx`SELECT count(*)::int AS n FROM oauth_connect_state WHERE id = ${connectStateA}`;
      return (r as { n: number }).n;
    });
    expect(right).toBe(1);
  });

  test("oauth_connect_state: tenant B cannot mint a handshake row for tenant A (RLS WITH CHECK)", async () => {
    let blocked = false;
    try {
      await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantB}, true)`;
        await tx`
          INSERT INTO oauth_connect_state
            (tenant_id, workspace_id, user_id, provider, state_token, pkce_verifier_enc, expires_at)
          VALUES (${tenantA}, ${wsA}, ${ownerA}, 'google', 'evil-cross-state',
                  '\\xc0ffee'::bytea, now() + interval '10 minutes')`;
      });
    } catch {
      blocked = true;
    }
    expect(blocked).toBe(true);
    const [r] =
      await admin`SELECT count(*)::int AS n FROM oauth_connect_state WHERE state_token = 'evil-cross-state'`;
    expect((r as { n: number }).n).toBe(0);
  });

  test("email_thread (workspace-scoped): wrong workspace GUC sees zero of the other workspace's threads; right sees its own", async () => {
    const wrong = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_workspace_id', ${wsB}, true)`;
      const [r] = await tx`SELECT count(*)::int AS n FROM email_thread WHERE id = ${threadA}`;
      return (r as { n: number }).n;
    });
    expect(wrong).toBe(0);

    const right = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_workspace_id', ${wsA}, true)`;
      const [r] = await tx`SELECT count(*)::int AS n FROM email_thread WHERE id = ${threadA}`;
      return (r as { n: number }).n;
    });
    expect(right).toBe(1);
  });

  test("email_message (workspace-scoped): wrong workspace GUC surfaces ZERO of the other workspace's messages — the encrypted body never leaks cross-tenant (D7)", async () => {
    const leaked = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_workspace_id', ${wsB}, true)`;
      const rows = await tx`SELECT body_enc FROM email_message WHERE tenant_id = ${tenantA}`;
      return rows.length;
    });
    expect(leaked).toBe(0);

    const own = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_workspace_id', ${wsA}, true)`;
      const [r] =
        await tx`SELECT count(*)::int AS n FROM email_message WHERE thread_id = ${threadA}`;
      return (r as { n: number }).n;
    });
    expect(own).toBe(1);
  });

  test("email_message: a workspace cannot INSERT a message into another workspace (RLS WITH CHECK)", async () => {
    let blocked = false;
    try {
      await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_workspace_id', ${wsB}, true)`;
        await tx`
          INSERT INTO email_message
            (tenant_id, workspace_id, thread_id, direction, from_addr, occurred_at)
          VALUES (${tenantA}, ${wsA}, ${threadA}, 'outbound', 'attacker@globex.com', now())`;
      });
    } catch {
      blocked = true;
    }
    expect(blocked).toBe(true);
  });

  test("repositories run under withTenantTx and return only the caller's own rows", async () => {
    const aDomains = await dbmod.sendingDomainRepository.listByTenant({ tenantId: tenantA });
    expect(aDomains.map((d) => d.id)).toEqual([domainA]);
    const bDomains = await dbmod.sendingDomainRepository.listByTenant({ tenantId: tenantB });
    expect(bDomains.map((d) => d.id)).toEqual([domainB]);

    const aMail = await dbmod.mailboxRepository.listByWorkspace({
      tenantId: tenantA,
      workspaceId: wsA,
    });
    expect(aMail.map((m) => m.id)).toEqual([mailboxA]);

    const aOpens = await dbmod.emailEventRepository.countByType(
      { tenantId: tenantA, workspaceId: wsA },
      "open",
    );
    expect(aOpens).toBe(1);
  });

  test("the mailbox read NEVER carries the encrypted credential (D7)", async () => {
    const [mailbox] = await dbmod.mailboxRepository.listByWorkspace({
      tenantId: tenantA,
      workspaceId: wsA,
    });
    expect(mailbox).toBeDefined();
    expect(mailbox).not.toHaveProperty("oauthTokenEnc");
    expect(mailbox).not.toHaveProperty("smtpSecretEnc");
    expect(JSON.stringify(mailbox)).not.toContain("deadbeef");
  });

  test("the send-quota no-overdraft CHECK makes an over-quota increment impossible", async () => {
    await admin`UPDATE tenants SET email_send_quota = 5, email_send_used = 5 WHERE id = ${tenantA}`;
    let threw = false;
    try {
      await admin`UPDATE tenants SET email_send_used = 6 WHERE id = ${tenantA}`;
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // Reset for the repository test below.
    await admin`UPDATE tenants SET email_send_quota = 2, email_send_used = 0 WHERE id = ${tenantA}`;
  });

  test("sendQuotaRepository: lock → assertWithinQuota → consume, then refuses over quota", async () => {
    // Two sends fit under the quota of 2.
    await dbmod.withTenantTx({ tenantId: tenantA, workspaceId: wsA }, async (tx) => {
      const snap = await dbmod.sendQuotaRepository.lock(tx, tenantA);
      dbmod.sendQuotaRepository.assertWithinQuota(snap);
      await dbmod.sendQuotaRepository.consume(tx, tenantA);
    });
    await dbmod.withTenantTx({ tenantId: tenantA, workspaceId: wsA }, async (tx) => {
      const snap = await dbmod.sendQuotaRepository.lock(tx, tenantA);
      dbmod.sendQuotaRepository.assertWithinQuota(snap);
      await dbmod.sendQuotaRepository.consume(tx, tenantA);
    });
    // The third is refused at the pre-check.
    let code = "";
    try {
      await dbmod.withTenantTx({ tenantId: tenantA, workspaceId: wsA }, async (tx) => {
        const snap = await dbmod.sendQuotaRepository.lock(tx, tenantA);
        dbmod.sendQuotaRepository.assertWithinQuota(snap);
        await dbmod.sendQuotaRepository.consume(tx, tenantA);
      });
    } catch (e) {
      code = (e as { code?: string }).code ?? "";
    }
    expect(code).toBe("send_quota_exceeded");
    const [r] = await admin`SELECT email_send_used AS u FROM tenants WHERE id = ${tenantA}`;
    expect((r as { u: number }).u).toBe(2); // exactly two consumed, the third never ran
  });
});
