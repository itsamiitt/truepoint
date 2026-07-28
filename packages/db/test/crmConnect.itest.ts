// crmConnect.itest.ts — the CRM OAuth connect flow end-to-end against a real Postgres (crm-sync 00 §5.2).
// Run in its OWN process (the db client is a module singleton):
//   bun test ./packages/db/test/crmConnect.itest.ts
//
// connectCrm.test.ts covers the pure gates (instance-URL validation, scope check, PKCE). This covers the
// two that only mean something with a database behind them:
//   - STATE IS SINGLE-USE AND ATOMIC. A replayed callback must lose, including when two arrive together.
//   - A CALLBACK CANNOT SELECT A TENANT. A handshake started by workspace A, completed while holding a
//     workspace-B session, must be refused — and must not leave a usable state behind afterwards.
// Plus the happy path: connection stored connected in SHADOW mode, defaults seeded, connect audited with no
// token material, and a reconnect that does not clobber tuned mappings.
//
// The connector is a fake: the point is our orchestration, and a fake lets the test assert what we HAND the
// exchange (the PKCE verifier we generated) rather than only what we do with the result.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, one, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");
type CoreConnect = typeof import("../../core/src/crm/connectCrm.ts");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let dbmod: DbModule;
let core: CoreConnect;

let tenantA = "";
let wsA = "";
let ownerA = "";
let tenantB = "";
let wsB = "";
let ownerB = "";

const scopeA = () => ({ tenantId: tenantA, workspaceId: wsA });
const scopeB = () => ({ tenantId: tenantB, workspaceId: wsB });

const REDIRECT = "https://app.truepoint.in/crm/callback";
const REQUESTED_SCOPES = ["api", "refresh_token", "offline_access"];

/** Records the verifier it was handed, so the test can prove the PKCE round-trip. */
function fakeConnector(overrides: Partial<Record<string, unknown>> = {}) {
  const seen: { codeVerifier?: string; code?: string } = {};
  const connector = {
    provider: "salesforce" as const,
    configured: true,
    seen,
    buildAuthorizeUrl(a: { state: string; codeChallenge: string; redirectUri: string }) {
      return `https://login.salesforce.com/services/oauth2/authorize?state=${a.state}&code_challenge=${a.codeChallenge}&redirect_uri=${encodeURIComponent(a.redirectUri)}`;
    },
    async exchangeCode(a: { code: string; codeVerifier: string }) {
      seen.code = a.code;
      seen.codeVerifier = a.codeVerifier;
      return {
        accessToken: "access-token-value",
        refreshToken: "refresh-token-value",
        expiresAt: Date.parse("2099-01-01T00:00:00Z"),
        scopes: REQUESTED_SCOPES,
        instanceUrl: "https://acme.my.salesforce.com",
        externalAccountId: "00D5g000004ABCD",
        environment: "production" as const,
        ...(overrides.bundle as object | undefined),
      };
    },
  };
  return connector;
}

async function seedTenant(slug: string) {
  const t = one<{ id: string }>(
    await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`,
    "tenant",
  );
  const u = one<{ id: string }>(
    await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`,
    "user",
  );
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner)
    VALUES (${t.id}, ${u.id}, true)`;
  const w = one<{ id: string }>(
    await admin`
      INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
      VALUES (${t.id}, ${slug}, ${slug}, true, ${u.id}) RETURNING id`,
    "workspace",
  );
  return { tenantId: t.id, wsId: w.id, ownerId: u.id };
}

beforeAll(async () => {
  dbHandle = await startItestDb("crmConnect");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });

  dbmod = await import("@leadwolf/db");
  core = await import("../../core/src/crm/connectCrm.ts");

  ({ tenantId: tenantA, wsId: wsA, ownerId: ownerA } = await seedTenant("acme"));
  ({ tenantId: tenantB, wsId: wsB, ownerId: ownerB } = await seedTenant("globex"));
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

async function start(connector: ReturnType<typeof fakeConnector>) {
  return core.startCrmConnect({
    scope: scopeA(),
    userId: ownerA,
    provider: "salesforce",
    // biome-ignore lint/suspicious/noExplicitAny: the fake implements only the connect surface under test
    connector: connector as any,
    redirectUri: REDIRECT,
    scopes: REQUESTED_SCOPES,
  });
}

describe("startCrmConnect", () => {
  test("persists a handshake and returns an authorize URL carrying state + challenge", async () => {
    const connector = fakeConnector();
    const { authorizeUrl, state } = await start(connector);

    expect(authorizeUrl).toContain(`state=${state}`);
    expect(authorizeUrl).toContain("code_challenge=");

    const row = one<{ workspace_id: string; consumed_at: Date | null; code_verifier_enc: unknown }>(
      await admin`
        SELECT workspace_id, consumed_at, code_verifier_enc FROM crm_oauth_states WHERE state = ${state}`,
      "handshake",
    );
    expect(row.workspace_id).toBe(wsA);
    expect(row.consumed_at).toBeNull();
    expect(row.code_verifier_enc).not.toBeNull(); // the verifier is stored ENCRYPTED, never in clear
  });

  test("creates NO crm_connections row — an abandoned consent leaves no junk behind", async () => {
    const before = one<{ n: number }>(
      await admin`SELECT count(*)::int AS n FROM crm_connections`,
      "count",
    );
    await start(fakeConnector());
    const after = one<{ n: number }>(
      await admin`SELECT count(*)::int AS n FROM crm_connections`,
      "count",
    );
    expect(after.n).toBe(before.n);
  });
});

describe("state is single-use", () => {
  test("a second consume of the same state returns null", async () => {
    const { state } = await start(fakeConnector());
    expect(await dbmod.crmOauthStateRepository.consume(state)).not.toBeNull();
    expect(await dbmod.crmOauthStateRepository.consume(state)).toBeNull();
  });

  test("two CONCURRENT consumes: exactly one wins", async () => {
    const { state } = await start(fakeConnector());
    // The race the atomic UPDATE...RETURNING exists for. A read-then-write consume would let both through.
    const [a, b] = await Promise.all([
      dbmod.crmOauthStateRepository.consume(state),
      dbmod.crmOauthStateRepository.consume(state),
    ]);
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
  });

  test("an expired handshake is not consumable", async () => {
    const { state } = await start(fakeConnector());
    await admin`UPDATE crm_oauth_states SET expires_at = now() - interval '1 second' WHERE state = ${state}`;
    expect(await dbmod.crmOauthStateRepository.consume(state)).toBeNull();
  });

  test("an unknown state returns null without distinguishing it from a spent one", async () => {
    expect(await dbmod.crmOauthStateRepository.consume("never-issued")).toBeNull();
  });
});

describe("the callback cannot select a tenant", () => {
  test("completing an A-handshake while holding a B-session is refused", async () => {
    const connector = fakeConnector();
    const { state } = await start(connector);

    let reason = "";
    try {
      await core.completeCrmConnect({
        sessionScope: scopeB(), // the attacker's own, verified session
        userId: ownerB,
        state, // a state minted for workspace A
        code: "auth-code",
        // biome-ignore lint/suspicious/noExplicitAny: fake connector
        connector: connector as any,
      });
    } catch (err) {
      reason = (err as { reason?: string }).reason ?? "";
    }
    expect(reason).toBe("workspace_mismatch");

    // No connection landed in EITHER workspace...
    const n = one<{ n: number }>(
      await admin`SELECT count(*)::int AS n FROM crm_connections WHERE workspace_id IN (${wsA}, ${wsB})`,
      "count",
    );
    expect(n.n).toBe(0);
    // ...and the exchange was never even attempted — the tenancy check runs BEFORE the network call.
    expect(connector.seen.code).toBeUndefined();
    // The state is spent regardless, so the attacker cannot retry it with a corrected session.
    expect(await dbmod.crmOauthStateRepository.consume(state)).toBeNull();
  });
});

describe("completeCrmConnect — the happy path", () => {
  test("stores a CONNECTED, SHADOW-mode connection, seeds mappings, and audits without token material", async () => {
    const connector = fakeConnector();
    const { state } = await start(connector);

    const result = await core.completeCrmConnect({
      sessionScope: scopeA(),
      userId: ownerA,
      state,
      code: "auth-code-abc",
      // biome-ignore lint/suspicious/noExplicitAny: fake connector
      connector: connector as any,
    });

    expect(result.provider).toBe("salesforce");
    expect(result.externalAccountId).toBe("00D5g000004ABCD");
    // Connecting a CRM never starts moving data — the operator flips this separately.
    expect(result.syncMode).toBe("shadow");
    expect(result.seededMappings).toBeGreaterThan(0);

    const rec = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.getById(tx, result.connectionId),
    );
    expect(rec?.status).toBe("connected");
    expect(rec?.syncMode).toBe("shadow");
    expect(rec?.instanceUrl).toBe("https://acme.my.salesforce.com");

    // The stored bundle decrypts to the real tokens...
    const { decryptCrmTokenBundle } = await import("../../core/src/crm/crmSecretStore.ts");
    const held = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.getEncryptedBundle(tx, result.connectionId),
    );
    const bundle = decryptCrmTokenBundle(held?.oauthTokenEnc as Uint8Array);
    expect(bundle.accessToken).toBe("access-token-value");
    expect(bundle.refreshToken).toBe("refresh-token-value");

    // ...and the audit row carries NONE of it.
    const auditRow = one<{ action: string; metadata: Record<string, unknown> }>(
      await admin`
        SELECT action, metadata FROM audit_log
        WHERE entity_id = ${result.connectionId} AND action = 'crm.connect'`,
      "audit",
    );
    const auditJson = JSON.stringify(auditRow.metadata);
    expect(auditJson).not.toContain("access-token-value");
    expect(auditJson).not.toContain("refresh-token-value");
    expect(auditRow.metadata.provider).toBe("salesforce");
  });

  test("the PKCE verifier handed to the exchange is the one we generated and stored", async () => {
    const connector = fakeConnector();
    const { state } = await start(connector);

    const stored = one<{ code_verifier_enc: Uint8Array }>(
      await admin`SELECT code_verifier_enc FROM crm_oauth_states WHERE state = ${state}`,
      "handshake",
    );
    const { decryptCrmSecret } = await import("../../core/src/crm/crmSecretStore.ts");
    const expected = decryptCrmSecret(stored.code_verifier_enc);

    await core.completeCrmConnect({
      sessionScope: scopeA(),
      userId: ownerA,
      state,
      code: "code-2",
      // biome-ignore lint/suspicious/noExplicitAny: fake connector
      connector: connector as any,
    });
    expect(connector.seen.codeVerifier).toBe(expected);
    expect(connector.seen.code).toBe("code-2");
  });

  test("re-authorising the SAME CRM org updates in place — no duplicate, no unique violation", async () => {
    // uniq_crm_connections_ws_provider_account permits exactly one connection per (workspace, provider,
    // CRM org). CI caught this: the first version of completeCrmConnect always INSERTed, so every re-auth
    // died on that index. The flow must find the existing row and update it.
    const connector = fakeConnector();
    const first = await core.completeCrmConnect({
      sessionScope: scopeA(),
      userId: ownerA,
      state: (await start(connector)).state,
      code: "c1",
      // biome-ignore lint/suspicious/noExplicitAny: fake connector
      connector: connector as any,
    });
    expect(first.reconnect).toBe(false);

    const second = await core.completeCrmConnect({
      sessionScope: scopeA(),
      userId: ownerA,
      state: (await start(connector)).state,
      code: "c2",
      // biome-ignore lint/suspicious/noExplicitAny: fake connector
      connector: connector as any,
    });
    expect(second.reconnect).toBe(true);
    expect(second.connectionId).toBe(first.connectionId); // same row, re-authorised

    const rows = one<{ n: number }>(
      await admin`
        SELECT count(*)::int AS n FROM crm_connections
        WHERE workspace_id = ${wsA} AND provider = 'salesforce'
          AND external_account_id = '00D5g000004ABCD'`,
      "count",
    );
    expect(rows.n).toBe(1);
  });

  test("a reconnect does NOT clobber mappings the customer has tuned, nor demote an enforcing connection", async () => {
    const connector = fakeConnector();
    const first = await core.completeCrmConnect({
      sessionScope: scopeA(),
      userId: ownerA,
      state: (await start(connector)).state,
      code: "c3",
      // biome-ignore lint/suspicious/noExplicitAny: fake connector
      connector: connector as any,
    });

    // The customer tunes a mapping, and an operator promotes the connection to enforce.
    await admin`
      UPDATE crm_field_mappings SET direction = 'outbound'
      WHERE connection_id = ${first.connectionId} AND tp_field = 'jobTitle'`;
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.setSyncMode(tx, first.connectionId, "enforce"),
    );

    const again = await core.completeCrmConnect({
      sessionScope: scopeA(),
      userId: ownerA,
      state: (await start(connector)).state,
      code: "c4",
      // biome-ignore lint/suspicious/noExplicitAny: fake connector
      connector: connector as any,
    });

    // Nothing re-seeded, the tuned direction survives...
    expect(again.seededMappings).toBe(0);
    const tuned = one<{ direction: string }>(
      await admin`
        SELECT direction FROM crm_field_mappings
        WHERE connection_id = ${first.connectionId} AND tp_field = 'jobTitle'`,
      "mapping",
    );
    expect(tuned.direction).toBe("outbound");

    // ...and the reported mode is the REAL one. A hardcoded 'shadow' here would tell the UI that an
    // enforcing connection had been silently demoted.
    expect(again.syncMode).toBe("enforce");
  });
});

describe("deleteExpired housekeeping", () => {
  test("removes expired handshakes, including consumed ones, and leaves live rows alone", async () => {
    const live = await start(fakeConnector());
    const dead = await start(fakeConnector());
    await admin`UPDATE crm_oauth_states SET expires_at = now() - interval '1 hour' WHERE state = ${dead.state}`;

    const removed = await dbmod.crmOauthStateRepository.deleteExpired(new Date());
    expect(removed).toBeGreaterThanOrEqual(1);

    const stillThere = one<{ n: number }>(
      await admin`SELECT count(*)::int AS n FROM crm_oauth_states WHERE state = ${live.state}`,
      "count",
    );
    expect(stillThere.n).toBe(1);
    const gone = one<{ n: number }>(
      await admin`SELECT count(*)::int AS n FROM crm_oauth_states WHERE state = ${dead.state}`,
      "count",
    );
    expect(gone.n).toBe(0);
  });
});
