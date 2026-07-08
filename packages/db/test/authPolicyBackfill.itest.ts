// authPolicyBackfill.itest.ts — proves effectivePolicyRepository.backfillTenantPolicies copies a configured
// tenant_auth_policies row into the auth_policies org key/value rows the effective-policy engine reads, on a
// real Postgres 16. Idempotent (ON CONFLICT DO NOTHING). Runs in its OWN process:
// `bun test ./packages/db/test/authPolicyBackfill.itest.ts`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let dbmod: DbModule;
let tenant = "";
let staff = "";

beforeAll(async () => {
  dbHandle = await startItestDb("authPolicyBackfill");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES ('acme','acme') RETURNING id`;
  tenant = (t as { id: string }).id;
  const [s] = await admin`INSERT INTO users (email) VALUES ('staff@backfill.test') RETURNING id`;
  staff = (s as { id: string }).id;

  // A configured policy: MFA required, SSO required, a restricted method set, a 1h cap, an IP allowlist.
  // disable_social/idle_timeout_seconds are left at their defaults (false / NULL).
  await admin`
    INSERT INTO tenant_auth_policies
      (tenant_id, mfa_enforcement, require_sso, allowed_methods, session_timeout_seconds, ip_allowlist)
    VALUES (${tenant}, 'required', true, '["sso","passkey"]'::jsonb, 3600, ARRAY['10.0.0.0/8'])`;

  dbmod = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("backfillTenantPolicies", () => {
  test("copies each configured value into auth_policies org rows; NULLs skipped; idempotent", async () => {
    await dbmod.withPlatformTx({ userId: staff }, "admin.backfill_auth_policies", (tx) =>
      dbmod.effectivePolicyRepository.backfillTenantPolicies(tx),
    );

    const rows = await admin`
      SELECT key, value FROM auth_policies WHERE scope='org' AND tenant_id=${tenant}`;
    const byKey = Object.fromEntries(
      rows.map((r) => [(r as { key: string }).key, (r as { value: unknown }).value]),
    );
    expect(byKey.mfa_enforcement).toBe("required");
    expect(byKey.require_sso).toBe(true);
    expect(byKey.allowed_methods).toEqual(["sso", "passkey"]);
    expect(byKey.session_timeout_seconds).toBe(3600);
    expect(byKey.ip_allowlist).toEqual(["10.0.0.0/8"]);
    expect(byKey.disable_social).toBe(false); // NOT NULL default → copied
    expect(byKey.idle_timeout_seconds).toBeUndefined(); // NULL → skipped

    // idempotent: a second run adds no duplicate rows (ON CONFLICT DO NOTHING)
    await dbmod.withPlatformTx({ userId: staff }, "admin.backfill_auth_policies", (tx) =>
      dbmod.effectivePolicyRepository.backfillTenantPolicies(tx),
    );
    const [count] = await admin`
      SELECT count(*)::int AS n FROM auth_policies WHERE scope='org' AND tenant_id=${tenant}`;
    expect((count as { n: number }).n).toBe(6); // 6 non-NULL keys (idle_timeout skipped)
  });
});
