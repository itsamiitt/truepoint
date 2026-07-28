// crmConnectionRepository.itest.ts — the credential-handling proof for crm_connections (crm-sync 00 §4.1 /
// §5.3 / §7.2). On a real Postgres 16 (Testcontainers by default, or ITEST_DATABASE_URL — see itestDb.ts).
// Run in its OWN process (the db client is a module singleton):
//   bun test ./packages/db/test/crmConnectionRepository.itest.ts
//
// crmIsolation.itest.ts proves the RLS wall. This proves the layer ABOVE it — the discipline that keeps an
// OAuth bundle out of everything that is not the one worker allowed to see it:
//   - insert() creates a PENDING row and takes no credential argument at all;
//   - every read projection (getById / listByWorkspace) OMITS oauth_token_enc — asserted structurally, so
//     adding the column to safeColumns later fails this test;
//   - markConnected is the only writer, and it does NOT promote sync_mode (a reconnect must never silently
//     start sending data);
//   - markError leaves a valid credential intact (a provider 500 must not destroy a refresh token);
//   - rotateToken rolls the credential without touching connect identity;
//   - the cross-tenant sweep worklists return ids + scope ONLY, never ciphertext;
//   - and the whole thing round-trips through the real crmSecretStore envelope.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, one, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let dbmod: DbModule;

let tenantA = "";
let wsA = "";
let ownerA = "";
let tenantB = "";
let wsB = "";
let ownerB = "";

const scopeA = () => ({ tenantId: tenantA, workspaceId: wsA });
const scopeB = () => ({ tenantId: tenantB, workspaceId: wsB });

async function seedTenant(
  slug: string,
): Promise<{ tenantId: string; wsId: string; ownerId: string }> {
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
  dbHandle = await startItestDb("crmConnRepo");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });

  // env is set above, BEFORE the db singleton loads.
  dbmod = await import("@leadwolf/db");

  ({ tenantId: tenantA, wsId: wsA, ownerId: ownerA } = await seedTenant("acme"));
  ({ tenantId: tenantB, wsId: wsB, ownerId: ownerB } = await seedTenant("globex"));
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

/** Create a connection in the given scope and return its id. */
async function newConnection(
  scope: { tenantId: string; workspaceId: string },
  ownerUserId: string,
  provider = "salesforce",
): Promise<string> {
  return dbmod.withTenantTx(scope, (tx) =>
    dbmod.crmConnectionRepository.insert(tx, {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      ownerUserId,
      provider,
    }),
  );
}

describe("crmConnectionRepository — connect lifecycle", () => {
  test("insert creates a PENDING, shadow-mode connection with no credential", async () => {
    const id = await newConnection(scopeA(), ownerA);
    const rec = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.getById(tx, id),
    );
    expect(rec?.status).toBe("pending");
    // shadow is the L3 dark-launch default — a fresh connection must never start in enforce.
    expect(rec?.syncMode).toBe("shadow");
    expect(rec?.connectedAt).toBeNull();

    const raw = one<{ oauth_token_enc: Uint8Array | null }>(
      await admin`SELECT oauth_token_enc FROM crm_connections WHERE id = ${id}`,
      "connection",
    );
    expect(raw.oauth_token_enc).toBeNull();
  });

  test("markConnected stores the real envelope and it round-trips", async () => {
    const { encryptCrmTokenBundle, decryptCrmTokenBundle } = await import(
      "../../core/src/crm-sync/crmSecretStore.ts"
    );
    const bundle = {
      accessToken: "access-abc",
      refreshToken: "refresh-xyz",
      expiresAt: 1_800_000_000_000,
      scopes: ["api", "refresh_token"],
      instanceUrl: "https://acme.my.salesforce.com",
      environment: "production" as const,
    };

    const id = await newConnection(scopeA(), ownerA);
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.markConnected(tx, id, {
        oauthTokenEnc: encryptCrmTokenBundle(bundle),
        tokenExpiresAt: new Date(bundle.expiresAt),
        scopes: bundle.scopes,
        externalAccountId: "00D5g000004ABCD",
        instanceUrl: bundle.instanceUrl,
      }),
    );

    const rec = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.getById(tx, id),
    );
    expect(rec?.status).toBe("connected");
    expect(rec?.externalAccountId).toBe("00D5g000004ABCD");
    expect(rec?.connectedAt).not.toBeNull();

    // The sanctioned read-back decrypts to exactly what went in.
    const held = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.getEncryptedBundle(tx, id),
    );
    expect(held?.oauthTokenEnc).not.toBeNull();
    expect(decryptCrmTokenBundle(held?.oauthTokenEnc as Uint8Array)).toEqual(bundle);
  });

  test("markConnected does NOT promote sync_mode — a reconnect never starts sending data", async () => {
    const { encryptCrmSecret } = await import("../../core/src/crm-sync/crmSecretStore.ts");
    const id = await newConnection(scopeA(), ownerA);

    // An operator has explicitly enforced this connection.
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.setSyncMode(tx, id, "enforce"),
    );
    // A later reconnect must leave that decision alone — in EITHER direction.
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.markConnected(tx, id, {
        oauthTokenEnc: encryptCrmSecret("second-grant"),
      }),
    );
    const rec = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.getById(tx, id),
    );
    expect(rec?.syncMode).toBe("enforce");
  });
});

describe("crmConnectionRepository — the credential never reaches a DTO", () => {
  test("getById's projection has no oauth_token_enc KEY at all (not merely a null value)", async () => {
    const { encryptCrmSecret } = await import("../../core/src/crm-sync/crmSecretStore.ts");
    const id = await newConnection(scopeA(), ownerA);
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.markConnected(tx, id, {
        oauthTokenEnc: encryptCrmSecret("must-not-leak"),
      }),
    );

    const rec = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.getById(tx, id),
    );
    // Structural, not value-based: if someone adds the column to safeColumns this fails even though the
    // ciphertext would still be "just bytes" to a value assertion.
    expect(Object.keys(rec ?? {})).not.toContain("oauthTokenEnc");
    expect(JSON.stringify(rec)).not.toContain("must-not-leak");
  });

  test("listByWorkspace carries no credential and is workspace-scoped", async () => {
    const { encryptCrmSecret } = await import("../../core/src/crm-sync/crmSecretStore.ts");
    const idA = await newConnection(scopeA(), ownerA, "hubspot");
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.markConnected(tx, idA, {
        oauthTokenEnc: encryptCrmSecret("workspace-a-secret"),
      }),
    );
    await newConnection(scopeB(), ownerB, "hubspot");

    const listA = await dbmod.crmConnectionRepository.listByWorkspace(scopeA());
    expect(listA.length).toBeGreaterThan(0);
    for (const row of listA) {
      expect(Object.keys(row)).not.toContain("oauthTokenEnc");
    }
    expect(JSON.stringify(listA)).not.toContain("workspace-a-secret");

    // Workspace B sees only its own — the RLS wall holds through the repository, not just in raw SQL.
    const listB = await dbmod.crmConnectionRepository.listByWorkspace(scopeB());
    const idsB = new Set(listB.map((r) => r.id));
    expect(idsB.has(idA)).toBe(false);
  });

  test("a foreign workspace cannot read another's encrypted bundle", async () => {
    const { encryptCrmSecret } = await import("../../core/src/crm-sync/crmSecretStore.ts");
    const idA = await newConnection(scopeA(), ownerA);
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.markConnected(tx, idA, {
        oauthTokenEnc: encryptCrmSecret("only-for-a"),
      }),
    );
    const asB = await dbmod.withTenantTx(scopeB(), (tx) =>
      dbmod.crmConnectionRepository.getEncryptedBundle(tx, idA),
    );
    expect(asB).toBeNull();
  });
});

describe("crmConnectionRepository — failure and rotation preserve the credential", () => {
  test("markError records the failure and leaves the credential intact", async () => {
    const { encryptCrmSecret, decryptCrmSecret } = await import(
      "../../core/src/crm-sync/crmSecretStore.ts"
    );
    const id = await newConnection(scopeA(), ownerA);
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.markConnected(tx, id, {
        oauthTokenEnc: encryptCrmSecret("survives-a-500"),
      }),
    );

    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.markError(tx, id, "provider returned 503"),
    );

    const rec = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.getById(tx, id),
    );
    expect(rec?.status).toBe("error");
    expect(rec?.lastError).toBe("provider returned 503");

    // The whole point: a transient provider failure must not destroy a valid refresh token.
    const held = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.getEncryptedBundle(tx, id),
    );
    expect(decryptCrmSecret(held?.oauthTokenEnc as Uint8Array)).toBe("survives-a-500");
  });

  test("markError truncates a long provider message to the column width", async () => {
    const id = await newConnection(scopeA(), ownerA);
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.markError(tx, id, "x".repeat(900)),
    );
    const rec = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.getById(tx, id),
    );
    // varchar(500): without the slice this INSERT would raise and lose the error entirely — the failure
    // path is exactly where a secondary failure is least affordable.
    expect(rec?.lastError?.length).toBe(500);
  });

  test("rotateToken rolls the credential without touching connect identity", async () => {
    const { encryptCrmSecret, decryptCrmSecret } = await import(
      "../../core/src/crm-sync/crmSecretStore.ts"
    );
    const id = await newConnection(scopeA(), ownerA);
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.markConnected(tx, id, {
        oauthTokenEnc: encryptCrmSecret("first"),
        scopes: ["api", "refresh_token"],
        externalAccountId: "ORG-1",
        instanceUrl: "https://acme.my.salesforce.com",
      }),
    );

    const later = new Date(Date.parse("2027-01-01T00:00:00Z"));
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.rotateToken(tx, id, encryptCrmSecret("second"), later),
    );

    const rec = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.getById(tx, id),
    );
    expect(rec?.externalAccountId).toBe("ORG-1"); // identity untouched
    expect(rec?.instanceUrl).toBe("https://acme.my.salesforce.com");
    expect(rec?.status).toBe("connected");
    expect(rec?.lastRefreshAt).not.toBeNull();

    const held = await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.getEncryptedBundle(tx, id),
    );
    expect(decryptCrmSecret(held?.oauthTokenEnc as Uint8Array)).toBe("second");
  });
});

describe("crmConnectionRepository — the cross-tenant sweep worklists", () => {
  test("listDueForRefresh returns ids + scope only, and only expiring connected rows", async () => {
    const { encryptCrmSecret } = await import("../../core/src/crm-sync/crmSecretStore.ts");

    const soon = await newConnection(scopeA(), ownerA);
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.markConnected(tx, soon, {
        oauthTokenEnc: encryptCrmSecret("expiring-soon"),
        tokenExpiresAt: new Date(Date.parse("2020-01-01T00:00:00Z")), // long past due
      }),
    );

    const far = await newConnection(scopeB(), ownerB);
    await dbmod.withTenantTx(scopeB(), (tx) =>
      dbmod.crmConnectionRepository.markConnected(tx, far, {
        oauthTokenEnc: encryptCrmSecret("expiring-far"),
        tokenExpiresAt: new Date(Date.parse("2099-01-01T00:00:00Z")),
      }),
    );

    const due = await dbmod.crmConnectionRepository.listDueForRefresh(60_000, 50);
    const dueIds = new Set(due.map((r) => r.id));
    expect(dueIds.has(soon)).toBe(true);
    expect(dueIds.has(far)).toBe(false);

    // No credential in a cross-tenant result set — and it spans tenants by construction, which is exactly
    // why the projection has to be checked rather than assumed.
    for (const row of due) {
      expect(Object.keys(row).sort()).toEqual(["id", "provider", "tenantId", "workspaceId"]);
    }
    expect(JSON.stringify(due)).not.toContain("expiring-soon");
  });

  test("listDueForPoll treats a never-polled connection as due", async () => {
    const { encryptCrmSecret } = await import("../../core/src/crm-sync/crmSecretStore.ts");
    const fresh = await newConnection(scopeA(), ownerA);
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.markConnected(tx, fresh, {
        oauthTokenEnc: encryptCrmSecret("never-polled"),
      }),
    );

    const dueNow = await dbmod.crmConnectionRepository.listDueForPoll(100);
    expect(new Set(dueNow.map((r) => r.id)).has(fresh)).toBe(true);

    // Once the cursor is set into the future the sweep leaves it alone.
    await dbmod.withTenantTx(scopeA(), (tx) =>
      dbmod.crmConnectionRepository.setNextPollAt(
        tx,
        fresh,
        new Date(Date.parse("2099-01-01T00:00:00Z")),
      ),
    );
    const dueLater = await dbmod.crmConnectionRepository.listDueForPoll(100);
    expect(new Set(dueLater.map((r) => r.id)).has(fresh)).toBe(false);
  });
});
