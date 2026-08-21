// apiKeys.itest.ts — the machine-credential repository proof on a real Postgres 16 (09 §4; ADR-0049).
// Testcontainers by default, or ITEST_DATABASE_URL (itestDb.ts). Requires src/migrations. Named *.itest.ts so
// default `bun test` skips it; run in its OWN process:
//   bun test packages/db/test/apiKeys.itest.ts
//
// This is the MANDATORY cross-tenant isolation test tenancy.md demands for a new tenant-owned table, plus the
// credential-specific properties that have no other guard:
//   (1) AUTH LOOKUP: findActiveByHash resolves a presented key's SHA-256 hash to EXACTLY its tenant, its
//       workspace and its scopes — the pre-tenant read that every downstream RLS scope is derived from. An
//       unknown hash and a revoked key both resolve to null (→ the middleware 401s, indistinguishably).
//   (2) TENANT ISOLATION (the ship gate): tenant1 cannot see, rotate or revoke tenant2's key. Every operation
//       addressed at a foreign id must report "nothing matched" rather than acting — which is both the RLS
//       policy and the explicit tenant predicate doing their jobs.
//   (3) NO SECRET EGRESS: the masked list projection has no hash column at all. A key's plaintext is
//       unrecoverable by construction, so the only thing that could leak is the hash — and it must not.
//   (4) ROTATE: replaces the secret IN PLACE (same id, same scopes), clears last_used_at, and leaves the old
//       hash unable to authenticate. This is the property that makes rotation safe to run under load.
//   (5) REVOKE: soft, idempotent, and immediately fatal to the credential.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("../src/index.ts");

let dbHandle: ItestDb;
let db: Db;
let admin: ReturnType<typeof postgres>;

let tenant1 = "";
let tenant2 = "";
let workspace1 = "";
let workspace2 = "";
let user1 = "";
let outsider = "";

const sha256Hex = (v: string): string => createHash("sha256").update(v).digest("hex");

async function seedUser(email: string): Promise<string> {
  const [u] =
    await admin`INSERT INTO users (email, status) VALUES (${email}, 'active') RETURNING id`;
  return (u as { id: string }).id;
}
async function seedTenant(slug: string): Promise<string> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  return (t as { id: string }).id;
}
async function seedWorkspace(tenantId: string, slug: string, userId: string): Promise<string> {
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, ${slug}, ${slug}, true, ${userId}) RETURNING id`;
  return (w as { id: string }).id;
}

beforeAll(async () => {
  dbHandle = await startItestDb("api_keys");

  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  process.env.APP_ORIGINS = "https://app.test";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });

  tenant1 = await seedTenant("acme");
  tenant2 = await seedTenant("globex");
  user1 = await seedUser("u1@acme.test");
  outsider = await seedUser("out@globex.test");
  workspace1 = await seedWorkspace(tenant1, "acme-ws", user1);
  workspace2 = await seedWorkspace(tenant2, "globex-ws", outsider);

  // env set BEFORE this dynamic import loads @leadwolf/config / the db singleton.
  db = await import("../src/index.ts");
  // 180s+ per CLAUDE.md: without it this hook inherits bun's 5s default and fails on container start, then
  // the teardown throws a TypeError on the unassigned handle that REPLACES the real error.
}, 240_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("api_keys repository", () => {
  test("findActiveByHash resolves a live key to its tenant, workspace and scopes", async () => {
    const secret = "tp_live_itest_alpha";
    const { id } = await db.apiKeyRepository.create({
      tenantId: tenant1,
      workspaceId: workspace1,
      name: "prod backend",
      keyHash: sha256Hex(secret),
      keyPrefix: "tp_live_alpha123",
      scopes: ["search:read", "reveal:write"],
      actorUserId: user1,
    });

    const auth = await db.apiKeyRepository.findActiveByHash(sha256Hex(secret));
    expect(auth).not.toBeNull();
    expect(auth?.id).toBe(id);
    // The whole isolation story: scope comes from the ROW, never from anything the caller sent.
    expect(auth?.tenantId).toBe(tenant1);
    expect(auth?.workspaceId).toBe(workspace1);
    expect(auth?.scopes.sort()).toEqual(["reveal:write", "search:read"]);

    // Unknown hash → null. The middleware turns this into the same uniform 401 a revoked key gets, so a
    // caller cannot probe which keys exist.
    expect(await db.apiKeyRepository.findActiveByHash(sha256Hex("tp_live_nope"))).toBeNull();
  });

  test("a revoked key stops authenticating", async () => {
    const secret = "tp_live_itest_revoke";
    const { id } = await db.apiKeyRepository.create({
      tenantId: tenant1,
      workspaceId: workspace1,
      name: "to be revoked",
      keyHash: sha256Hex(secret),
      keyPrefix: "tp_live_revoke12",
      scopes: ["search:read"],
      actorUserId: user1,
    });
    expect(await db.apiKeyRepository.findActiveByHash(sha256Hex(secret))).not.toBeNull();

    expect(await db.apiKeyRepository.revoke(tenant1, id, user1)).toBe(true);
    expect(await db.apiKeyRepository.findActiveByHash(sha256Hex(secret))).toBeNull();

    // Idempotent: a second revoke reports false rather than logging a second revocation.
    expect(await db.apiKeyRepository.revoke(tenant1, id, user1)).toBe(false);
  });

  test("TENANT ISOLATION — tenant1 cannot see, rotate or revoke tenant2's key", async () => {
    const foreignSecret = "tp_live_itest_globex";
    const { id: foreignId } = await db.apiKeyRepository.create({
      tenantId: tenant2,
      workspaceId: workspace2,
      name: "globex key",
      keyHash: sha256Hex(foreignSecret),
      keyPrefix: "tp_live_globex12",
      scopes: ["search:read"],
      actorUserId: outsider,
    });

    // The list is scoped by RLS + the explicit predicate — tenant2's key is simply not in it.
    const mine = await db.apiKeyRepository.listForTenant(tenant1);
    expect(mine.some((k) => k.id === foreignId)).toBe(false);

    // Addressing a foreign id directly matches nothing. Both report false rather than throwing, so the route
    // renders the same 404 a missing id gets and ids cannot be enumerated across tenants.
    expect(
      await db.apiKeyRepository.rotate({
        tenantId: tenant1,
        id: foreignId,
        keyHash: sha256Hex("tp_live_attacker"),
        keyPrefix: "tp_live_attack12",
        actorUserId: user1,
      }),
    ).toBe(false);
    expect(await db.apiKeyRepository.revoke(tenant1, foreignId, user1)).toBe(false);

    // And the foreign key is untouched — the rotate above must not have changed its secret.
    const stillLive = await db.apiKeyRepository.findActiveByHash(sha256Hex(foreignSecret));
    expect(stillLive?.tenantId).toBe(tenant2);
  });

  test("the masked list never carries the hash", async () => {
    const rows = await db.apiKeyRepository.listForTenant(tenant1);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // Not "the hash is empty" — the property is that the projection has no such key at all.
      expect(Object.keys(row)).not.toContain("keyHash");
      expect(JSON.stringify(row)).not.toContain(sha256Hex("tp_live_itest_alpha"));
    }
  });

  test("rotate replaces the secret in place and retires the old one", async () => {
    const oldSecret = "tp_live_itest_rotate_old";
    const { id } = await db.apiKeyRepository.create({
      tenantId: tenant1,
      workspaceId: workspace1,
      name: "rotating",
      keyHash: sha256Hex(oldSecret),
      keyPrefix: "tp_live_rotold12",
      scopes: ["search:read", "export:write"],
      actorUserId: user1,
    });
    await db.apiKeyRepository.touchLastUsed(tenant1, id);

    const newSecret = "tp_live_itest_rotate_new";
    expect(
      await db.apiKeyRepository.rotate({
        tenantId: tenant1,
        id,
        keyHash: sha256Hex(newSecret),
        keyPrefix: "tp_live_rotnew12",
        actorUserId: user1,
      }),
    ).toBe(true);

    // Same identity, same scopes — the row keeps its place in the customer's inventory.
    const after = await db.apiKeyRepository.findActiveByHash(sha256Hex(newSecret));
    expect(after?.id).toBe(id);
    expect(after?.scopes.sort()).toEqual(["export:write", "search:read"]);

    // The old secret is dead the moment the new one exists.
    expect(await db.apiKeyRepository.findActiveByHash(sha256Hex(oldSecret))).toBeNull();

    // last_used_at described the OLD secret; leaving it would make a fresh key look already-used.
    const row = (await db.apiKeyRepository.listForTenant(tenant1)).find((k) => k.id === id);
    expect(row?.lastUsedAt).toBeNull();
    expect(row?.keyPrefix).toBe("tp_live_rotnew12");
  });

  test("touchLastUsed bumps the monitoring column", async () => {
    const secret = "tp_live_itest_touch";
    const { id } = await db.apiKeyRepository.create({
      tenantId: tenant1,
      workspaceId: workspace1,
      name: "touched",
      keyHash: sha256Hex(secret),
      keyPrefix: "tp_live_touch123",
      scopes: ["search:read"],
      actorUserId: user1,
    });
    const before = (await db.apiKeyRepository.listForTenant(tenant1)).find((k) => k.id === id);
    expect(before?.lastUsedAt).toBeNull();

    await db.apiKeyRepository.touchLastUsed(tenant1, id);

    const after = (await db.apiKeyRepository.listForTenant(tenant1)).find((k) => k.id === id);
    expect(after?.lastUsedAt).not.toBeNull();
  });

  test("the create is audited without recording the secret", async () => {
    const secret = "tp_live_itest_audit";
    const { id } = await db.apiKeyRepository.create({
      tenantId: tenant1,
      workspaceId: workspace1,
      name: "audited",
      keyHash: sha256Hex(secret),
      keyPrefix: "tp_live_audit123",
      scopes: ["search:read"],
      actorUserId: user1,
    });

    const rows = await admin`
      SELECT action, entity_type, metadata FROM audit_log
       WHERE tenant_id = ${tenant1} AND entity_id = ${id}`;
    expect(rows.length).toBe(1);
    const row = rows[0] as { action: string; entity_type: string; metadata: unknown };
    expect(row.action).toBe("settings.update");
    expect(row.entity_type).toBe("api_key");
    // The audit trail records what was created, never the credential itself.
    const meta = JSON.stringify(row.metadata);
    expect(meta).not.toContain(secret);
    expect(meta).not.toContain(sha256Hex(secret));
    expect(meta).toContain("api_key.create");
  });
});
