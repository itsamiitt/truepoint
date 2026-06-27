// authPolicyEnforcement.itest.ts — the P1-01 per-tenant enforcement-switch Definition-of-Done on a real
// Postgres 16 (ADR-0018). Testcontainers by default, or ITEST_DATABASE_URL (itestDb.ts). Requires generated
// src/migrations. Named *.itest.ts so default `bun test` skips it; run in its OWN process:
//   bun test packages/db/test/authPolicyEnforcement.itest.ts
//
// Proves the load-bearing safety contract behind the lockout-capable login gates (packages/auth flow/refresh):
//   (1) DEFAULT OFF: an unconfigured tenant resolves enforcementEnabled=false — no tenant is enforced until a
//       platform super_admin explicitly enables it (the strict-safety property of moving off the global-only flag).
//   (2) STAFF-ONLY / NON-CLOBBERING: a tenant security_admin policy upsert (which carries NO enforcement field)
//       never flips the switch, and the staff enable never clobbers the tenant's editable policy.
//   (3) ENABLE / BREAK-GLASS: setEnforcement(true) via the withPlatformTx owner path enables it (seeding a
//       default policy row when the tenant has none); setEnforcement(false) is the break-glass that re-opens login.
//   (4) AUDIT-PER-WRITE: every toggle lands exactly one platform_audit_log row in the same transaction.
//   (5) TENANT-EDITABLE FIELDS: the absolute + idle timeouts round-trip through the tenant policy contract.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AuthPolicy } from "@leadwolf/types";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("../src/index.ts");

let dbHandle: ItestDb;
let db: Db;
let admin: ReturnType<typeof postgres>;

let tenant1 = ""; // gets a tenant-configured policy
let tenant2 = ""; // never configures a policy (proves setEnforcement seeds defaults)
let actor = ""; // the platform super_admin acting on the switch (platform_audit_log.actor_user_id)

async function seedTenant(slug: string): Promise<string> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  return (t as { id: string }).id;
}
async function seedUser(email: string): Promise<string> {
  const [u] =
    await admin`INSERT INTO users (email, status) VALUES (${email}, 'active') RETURNING id`;
  return (u as { id: string }).id;
}
async function enforcementAuditCount(): Promise<number> {
  const [row] =
    await admin`SELECT count(*)::int AS c FROM platform_audit_log WHERE action = 'admin.set_auth_enforcement'`;
  return (row as { c: number }).c;
}
// Drive setEnforcement exactly as the /api/v1/admin route does — through the audited withPlatformTx owner path.
function setEnforcement(tenantId: string, enabled: boolean): Promise<void> {
  return db.withPlatformTx(
    { userId: actor, ip: null },
    "admin.set_auth_enforcement",
    (tx) => db.authPolicyRepository.setEnforcement(tx, tenantId, enabled),
    { targetType: "tenant", targetId: tenantId, tenantId, metadata: { enabled } },
  );
}

beforeAll(async () => {
  dbHandle = await startItestDb("authpolicyenforcement");

  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  process.env.APP_ORIGINS = "https://app.test";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  tenant1 = await seedTenant("acme");
  tenant2 = await seedTenant("globex");
  actor = await seedUser("staff@truepoint.test");

  // env set BEFORE this dynamic import loads @leadwolf/config / the db singleton.
  db = await import("../src/index.ts");
}, 240_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("auth-policy per-tenant enforcement switch (P1-01)", () => {
  test("default: an unconfigured tenant is NOT enforced (enforcementEnabled=false)", async () => {
    const resolved = await db.authPolicyRepository.getForEnforcement(tenant1);
    expect(resolved.enforcementEnabled).toBe(false);
    expect(resolved.policy.mfaEnforcement).toBe("optional"); // the platform default policy
  });

  test("a tenant policy upsert never flips the staff-only switch; tenant timeouts round-trip", async () => {
    const policy: AuthPolicy = {
      mfaEnforcement: "required",
      allowedMethods: ["password", "sso"],
      disableSocial: false,
      requireSso: false,
      ipAllowlist: ["10.0.0.0/8"],
      sessionTimeoutSeconds: 3600, // absolute cap
      idleTimeoutSeconds: 900, // idle window
    };
    await db.authPolicyRepository.upsert(tenant1, policy, actor);

    const after = await db.authPolicyRepository.getForEnforcement(tenant1);
    expect(after.enforcementEnabled).toBe(false); // still OFF — the tenant cannot self-enable
    expect(after.policy.sessionTimeoutSeconds).toBe(3600);
    expect(after.policy.idleTimeoutSeconds).toBe(900);
  });

  test("staff setEnforcement(true) enables it WITHOUT clobbering the tenant's policy", async () => {
    await setEnforcement(tenant1, true);

    const after = await db.authPolicyRepository.getForEnforcement(tenant1);
    expect(after.enforcementEnabled).toBe(true);
    // The tenant's editable policy from the previous upsert is preserved across the staff flag write.
    expect(after.policy.mfaEnforcement).toBe("required");
    expect(after.policy.idleTimeoutSeconds).toBe(900);
  });

  test("setEnforcement seeds a default policy row when the tenant has none; break-glass disables", async () => {
    expect((await db.authPolicyRepository.getForEnforcement(tenant2)).enforcementEnabled).toBe(false);

    await setEnforcement(tenant2, true);
    const enabled = await db.authPolicyRepository.getForEnforcement(tenant2);
    expect(enabled.enforcementEnabled).toBe(true);
    expect(enabled.policy.mfaEnforcement).toBe("optional"); // defaults seeded, not corrupted

    // Break-glass: disabling re-opens login without a deploy.
    await setEnforcement(tenant2, false);
    expect((await db.authPolicyRepository.getForEnforcement(tenant2)).enforcementEnabled).toBe(false);
  });

  test("every setEnforcement write lands exactly one platform_audit_log row", async () => {
    const before = await enforcementAuditCount();
    await setEnforcement(tenant1, false);
    expect(await enforcementAuditCount()).toBe(before + 1);
    await setEnforcement(tenant1, true);
    expect(await enforcementAuditCount()).toBe(before + 2);
  });
});
