// reveal.itest.ts — the M3 Definition-of-Done proof on a real Postgres 16 (10/14 §3.4): Testcontainers by
// default, or an external server via ITEST_DATABASE_URL (see itestDb.ts). Requires generated src/migrations
// (`bun run --filter @leadwolf/db generate`). Named *.itest.ts so default `bun test` skips it; run
// explicitly: `bun test packages/db/test/reveal.itest.ts`.
//
// Proves the money-loop invariants (07 §3, ADR-0007): (1) first reveal charges once + flips ownership via
// the trigger; (2) re-revealing the same workspace copy is free; (3) the same human in another workspace is
// charged again; (4) N concurrent reveals of one contact never double-charge; (5) concurrent reveals under a
// 1-credit balance never overdraw; (6) below-balance rolls back with no reveal row; (7) a suppressed contact
// never reveals even with credits and the reveal.blocked audit SURVIVES the rollback; (8) duplicate Stripe
// webhook events grant exactly once.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("@leadwolf/core");

let dbHandle: ItestDb;
let core: Core;
let admin: ReturnType<typeof postgres>;
let tenantA = "";
let tenantB = "";
let wsA = "";
let wsB = "";
let ownerA = "";
let ownerB = "";

const MAPPING = {
  email: "Email",
  firstName: "First Name",
  lastName: "Last Name",
  accountName: "Company",
  accountDomain: "Domain",
};
const ROWS = [
  {
    Email: "jane@acme.com",
    "First Name": "Jane",
    "Last Name": "Doe",
    Company: "Acme",
    Domain: "acme.com",
  },
  {
    Email: "mark@globex.com",
    "First Name": "Mark",
    "Last Name": "Roe",
    Company: "Globex",
    Domain: "globex.com",
  },
  {
    Email: "lena@initech.com",
    "First Name": "Lena",
    "Last Name": "Lee",
    Company: "Initech",
    Domain: "initech.com",
  },
];

async function seedWorkspace(
  slug: string,
): Promise<{ tenantId: string; workspaceId: string; ownerId: string }> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  await admin`INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${t!.id}, ${u!.id}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${t!.id}, ${slug}, ${slug}, true, ${u!.id}) RETURNING id`;
  return { tenantId: t!.id, workspaceId: w!.id, ownerId: u!.id };
}

async function setBalance(tenantId: string, balance: number): Promise<void> {
  await admin`UPDATE tenants SET reveal_credit_balance = ${balance} WHERE id = ${tenantId}`;
}

async function balanceOf(tenantId: string): Promise<number> {
  const [r] = await admin`SELECT reveal_credit_balance AS b FROM tenants WHERE id = ${tenantId}`;
  return (r as { b: number }).b;
}

async function contactIdByDomain(workspaceId: string, emailDomain: string): Promise<string> {
  const [r] = await admin`
    SELECT id FROM contacts WHERE workspace_id = ${workspaceId} AND email_domain = ${emailDomain}`;
  return (r as { id: string }).id;
}

beforeAll(async () => {
  dbHandle = await startItestDb("reveal");

  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA, ownerId: ownerA } = await seedWorkspace("acme"));
  ({ tenantId: tenantB, workspaceId: wsB, ownerId: ownerB } = await seedWorkspace("globex"));

  core = await import("@leadwolf/core");
  // Seed identical books into both workspaces through the real import pipeline (encrypted PII + blind index).
  await core.runImport({
    scope: { tenantId: tenantA, workspaceId: wsA },
    sourceName: "manual",
    mapping: MAPPING,
    rows: ROWS,
  });
  await core.runImport({
    scope: { tenantId: tenantB, workspaceId: wsB },
    sourceName: "manual",
    mapping: MAPPING,
    rows: ROWS,
  });
}, 180_000);

afterAll(async () => {
  // Drain the @leadwolf/db singleton pool first — its open sockets otherwise keep the runner alive.
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("M3 reveal & credits DoD", () => {
  test("first reveal charges once, returns plaintext, and the trigger flips ownership first-wins", async () => {
    await setBalance(tenantA, 10);
    const contactId = await contactIdByDomain(wsA, "acme.com");

    const res = await core.revealContact({
      scope: { tenantId: tenantA, workspaceId: wsA },
      userId: ownerA,
      contactId,
      revealType: "email",
    });
    expect(res.alreadyOwned).toBe(false);
    expect(res.creditsCharged).toBe(1);
    expect(res.balanceAfter).toBe(9);
    expect(res.email).toBe("jane@acme.com");
    expect(await balanceOf(tenantA)).toBe(9);

    const [c] =
      await admin`SELECT is_revealed, revealed_by_user_id FROM contacts WHERE id = ${contactId}`;
    expect((c as { is_revealed: boolean }).is_revealed).toBe(true);
    expect((c as { revealed_by_user_id: string }).revealed_by_user_id).toBe(ownerA);

    const [a] = await admin`
      SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = ${tenantA} AND action = 'reveal' AND entity_id = ${contactId}`;
    expect((a as { n: number }).n).toBe(1);
  });

  test("re-revealing the same workspace copy is free, forever", async () => {
    const contactId = await contactIdByDomain(wsA, "acme.com");
    const res = await core.revealContact({
      scope: { tenantId: tenantA, workspaceId: wsA },
      userId: ownerA,
      contactId,
      revealType: "email",
    });
    expect(res.alreadyOwned).toBe(true);
    expect(res.creditsCharged).toBe(0);
    expect(res.email).toBe("jane@acme.com");
    expect(await balanceOf(tenantA)).toBe(9);
  });

  test("the same human in another workspace is a separate copy and is charged again", async () => {
    await setBalance(tenantB, 5);
    const contactId = await contactIdByDomain(wsB, "acme.com");
    const res = await core.revealContact({
      scope: { tenantId: tenantB, workspaceId: wsB },
      userId: ownerB,
      contactId,
      revealType: "email",
    });
    expect(res.alreadyOwned).toBe(false);
    expect(res.creditsCharged).toBe(1);
    expect(await balanceOf(tenantB)).toBe(4);
  });

  test("N concurrent reveals of one contact charge exactly once (FOR UPDATE + unique claim)", async () => {
    const contactId = await contactIdByDomain(wsA, "globex.com");
    const before = await balanceOf(tenantA);

    const results = await Promise.allSettled(
      Array.from({ length: 15 }, () =>
        core.revealContact({
          scope: { tenantId: tenantA, workspaceId: wsA },
          userId: ownerA,
          contactId,
          revealType: "email",
        }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBe(15); // duplicates resolve as free alreadyOwned reads, never double-charge

    expect(await balanceOf(tenantA)).toBe(before - 1);
    const [n] = await admin`
      SELECT count(*)::int AS n FROM contact_reveals WHERE workspace_id = ${wsA} AND contact_id = ${contactId}`;
    expect((n as { n: number }).n).toBe(1);
  });

  test("below-balance reveals roll back: no charge, no reveal row, balance unchanged", async () => {
    await setBalance(tenantB, 0);
    const contactId = await contactIdByDomain(wsB, "globex.com");

    await expect(
      core.revealContact({
        scope: { tenantId: tenantB, workspaceId: wsB },
        userId: ownerB,
        contactId,
        revealType: "email",
      }),
    ).rejects.toMatchObject({ code: "insufficient_credits" });

    expect(await balanceOf(tenantB)).toBe(0);
    const [n] = await admin`
      SELECT count(*)::int AS n FROM contact_reveals WHERE workspace_id = ${wsB} AND contact_id = ${contactId}`;
    expect((n as { n: number }).n).toBe(0);
  });

  test("concurrent reveals of different contacts under a 1-credit balance never overdraw", async () => {
    await setBalance(tenantB, 1);
    const c1 = await contactIdByDomain(wsB, "globex.com");
    const c2 = await contactIdByDomain(wsB, "initech.com");

    const results = await Promise.allSettled([
      core.revealContact({
        scope: { tenantId: tenantB, workspaceId: wsB },
        userId: ownerB,
        contactId: c1,
        revealType: "email",
      }),
      core.revealContact({
        scope: { tenantId: tenantB, workspaceId: wsB },
        userId: ownerB,
        contactId: c2,
        revealType: "email",
      }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(1);
    expect(await balanceOf(tenantB)).toBe(0);
  });

  test("a suppressed contact never reveals even with credits; reveal.blocked survives the rollback", async () => {
    await setBalance(tenantA, 10);
    const contactId = await contactIdByDomain(wsA, "initech.com");
    // Global-scope domain suppression (e.g. a GDPR objection) — visible to every workspace (08 §3).
    await admin`
      INSERT INTO suppression_list (scope, match_type, domain, reason)
      VALUES ('global', 'domain', 'initech.com', 'gdpr_objection')`;

    const before = await balanceOf(tenantA);
    await expect(
      core.revealContact({
        scope: { tenantId: tenantA, workspaceId: wsA },
        userId: ownerA,
        contactId,
        revealType: "email",
      }),
    ).rejects.toMatchObject({ code: "suppressed" });

    expect(await balanceOf(tenantA)).toBe(before);
    const [n] = await admin`
      SELECT count(*)::int AS n FROM contact_reveals WHERE workspace_id = ${wsA} AND contact_id = ${contactId}`;
    expect((n as { n: number }).n).toBe(0);
    const [a] = await admin`
      SELECT count(*)::int AS n FROM audit_log
      WHERE tenant_id = ${tenantA} AND action = 'reveal.blocked' AND entity_id = ${contactId}`;
    expect((a as { n: number }).n).toBe(1);
  });

  test("audit_log is append-only at the DB layer", async () => {
    // postgres.js queries are LAZY thenables (they execute on await) — wrap them in a real async fn so
    // the assertion path always fires the query instead of handing the runner a pending thenable.
    const rejectionOf = async (run: () => Promise<unknown>): Promise<unknown> => {
      try {
        await run();
        return null;
      } catch (err) {
        return err;
      }
    };
    const upd = await rejectionOf(
      async () => await admin`UPDATE audit_log SET action = 'reveal' WHERE tenant_id = ${tenantA}`,
    );
    expect(String(upd)).toContain("append-only");
    const del = await rejectionOf(
      async () => await admin`DELETE FROM audit_log WHERE tenant_id = ${tenantA}`,
    );
    expect(String(del)).toContain("append-only");
  });

  test("a duplicate Stripe webhook event grants credits exactly once", async () => {
    await setBalance(tenantA, 0);
    const event = {
      stripeEventId: "evt_itest_1",
      stripePaymentIntentId: "pi_itest_1",
      tenantId: tenantA,
      credits: 500,
      amountCents: 4900,
    };
    const first = await core.grantFromStripe(event);
    expect(first.granted).toBe(true);
    expect(first.balanceAfter).toBe(500);

    const replay = await core.grantFromStripe(event);
    expect(replay.granted).toBe(false);
    expect(replay.balanceAfter).toBe(500);
    expect(await balanceOf(tenantA)).toBe(500);
  });
});
