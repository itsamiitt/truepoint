// scim.itest.ts — the SCIM 2.0 repository-layer Definition-of-Done proof on a real Postgres 16 (10/14 §3.5;
// 09 "SCIM deprovisioning race & token abuse"). Testcontainers by default, or ITEST_DATABASE_URL (itestDb.ts).
// Requires generated src/migrations. Named *.itest.ts so default `bun test` skips it; run in its OWN process:
//   bun test packages/db/test/scim.itest.ts
//
// Proves the LOAD-BEARING SCIM data contract — the tenant isolation that backs every /scim/v2 operation:
//   (1) TOKEN AUTH: findActiveByHash resolves a presented token's SHA-256 hash to EXACTLY its tenant; a revoked
//       token and an unknown hash both resolve to null (→ the middleware 401s). This is the pre-tenant lookup.
//   (2) TENANT ISOLATION (the ship gate): a token scoped to tenant1 can only ever read/touch tenant1's members.
//       findScimMemberByUserId(tenant1, userInTenant2) is null (a cross-tenant :id 404s); listScimMembers /
//       countScimMembers never include tenant2's rows; setMembershipStatusInTx under tenant1 cannot flip
//       tenant2's membership (0 rows affected — RLS + the WHERE).
//   (3) DEPROVISION: setMembershipStatusInTx(tenant1, user, 'deactivated') flips the membership to deactivated
//       (the durable source of truth — the SCIM service then calls revokeAllSessionsForUser to cut live access).
//   (4) last_used_at: touchLastUsed bumps the column (wires the WIRE-deferred monitoring signal).

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
let user1 = ""; // active member of tenant1
let user2 = ""; // active member of tenant1 (deprovision target)
let outsider = ""; // active member of tenant2 (the cross-tenant isolation target)

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
async function addTenantMember(tenantId: string, userId: string): Promise<void> {
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, status) VALUES (${tenantId}, ${userId}, 'active')`;
}
async function seedScimToken(tenantId: string, name: string, plaintext: string): Promise<string> {
  const [row] = await admin`
    INSERT INTO scim_tokens (tenant_id, name, token_hash) VALUES (${tenantId}, ${name}, ${sha256Hex(plaintext)})
    RETURNING id`;
  return (row as { id: string }).id;
}
async function membershipStatus(tenantId: string, userId: string): Promise<string | null> {
  const [m] = await admin`
    SELECT status FROM tenant_members WHERE tenant_id = ${tenantId} AND user_id = ${userId}`;
  return (m as { status: string } | undefined)?.status ?? null;
}

beforeAll(async () => {
  dbHandle = await startItestDb("scim");

  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  process.env.APP_ORIGINS = "https://app.test";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });

  tenant1 = await seedTenant("acme");
  tenant2 = await seedTenant("globex");
  user1 = await seedUser("u1@acme.test");
  user2 = await seedUser("u2@acme.test");
  outsider = await seedUser("out@globex.test");
  await addTenantMember(tenant1, user1);
  await addTenantMember(tenant1, user2);
  await addTenantMember(tenant2, outsider);

  // env set BEFORE this dynamic import loads @leadwolf/config / the db singleton.
  db = await import("../src/index.ts");
}, 240_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("SCIM repository DoD", () => {
  test("findActiveByHash resolves a live token to its tenant; revoked/unknown → null", async () => {
    const tokenId = await seedScimToken(tenant1, "okta-prod", "scim_live_token");
    const auth = await db.scimTokenRepository.findActiveByHash(sha256Hex("scim_live_token"));
    expect(auth).not.toBeNull();
    expect(auth?.tenantId).toBe(tenant1);
    expect(auth?.id).toBe(tokenId);

    // Unknown hash → null (the middleware 401s — uniform, no enumeration).
    expect(await db.scimTokenRepository.findActiveByHash(sha256Hex("nope"))).toBeNull();

    // Revoked token → null.
    await admin`UPDATE scim_tokens SET revoked_at = now() WHERE id = ${tokenId}`;
    expect(await db.scimTokenRepository.findActiveByHash(sha256Hex("scim_live_token"))).toBeNull();
  });

  test("touchLastUsed bumps last_used_at (wires the monitoring signal)", async () => {
    const tokenId = await seedScimToken(tenant1, "entra-prod", "scim_touch_token");
    await db.scimTokenRepository.touchLastUsed(tenant1, tokenId);
    const [row] = await admin`SELECT last_used_at FROM scim_tokens WHERE id = ${tokenId}`;
    expect((row as { last_used_at: Date | null }).last_used_at).not.toBeNull();
  });

  test("tenant isolation: a tenant1 read can never see tenant2's member (cross-tenant :id is null)", async () => {
    // The outsider is a member of tenant2 only; reading them under tenant1 must return null (the route 404s).
    expect(await db.tenantMemberRepository.findScimMemberByUserId(tenant1, outsider)).toBeNull();
    // And they ARE visible under their own tenant.
    const own = await db.tenantMemberRepository.findScimMemberByUserId(tenant2, outsider);
    expect(own?.userId).toBe(outsider);
    expect(own?.active).toBe(true);
  });

  test("list/count under tenant1 exclude tenant2's members", async () => {
    const count1 = await db.tenantMemberRepository.countScimMembers(tenant1);
    const members1 = await db.tenantMemberRepository.listScimMembers(tenant1, {
      offset: 0,
      limit: 100,
    });
    const ids = new Set(members1.map((m) => m.userId));
    expect(ids.has(user1)).toBe(true);
    expect(ids.has(user2)).toBe(true);
    expect(ids.has(outsider)).toBe(false); // tenant2's member never appears
    expect(count1).toBe(members1.length);
  });

  test("deprovision flips the membership to deactivated; can't touch another tenant's row", async () => {
    // setMembershipStatusInTx is tx-scoped; drive it through withTenantTx as the SCIM service does.
    const flipped = await db.withTenantTx({ tenantId: tenant1 }, (tx) =>
      db.tenantMemberRepository.setMembershipStatusInTx(tx, tenant1, user2, "deactivated"),
    );
    expect(flipped).toBe(1);
    expect(await membershipStatus(tenant1, user2)).toBe("deactivated");

    // A tenant1-scoped tx can NOT flip tenant2's member (RLS USING + the WHERE) — 0 rows, status unchanged.
    const crossTenant = await db.withTenantTx({ tenantId: tenant1 }, (tx) =>
      db.tenantMemberRepository.setMembershipStatusInTx(tx, tenant1, outsider, "deactivated"),
    );
    expect(crossTenant).toBe(0);
    expect(await membershipStatus(tenant2, outsider)).toBe("active");

    // Re-provision flips it back to active.
    const reactivated = await db.withTenantTx({ tenantId: tenant1 }, (tx) =>
      db.tenantMemberRepository.setMembershipStatusInTx(tx, tenant1, user2, "active"),
    );
    expect(reactivated).toBe(1);
    expect(await membershipStatus(tenant1, user2)).toBe("active");
  });
});
