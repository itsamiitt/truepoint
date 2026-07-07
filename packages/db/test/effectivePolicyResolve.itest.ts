// effectivePolicyResolve.itest.ts — the resolver-correctness proof for the Phase-1 effective-policy engine (doc
// 11 §3, doc 12): the DB read (effectivePolicyRepository.getScopeRows, RLS-scoped under withTenantTx) feeding
// the pure resolver (@leadwolf/auth resolvePolicyFromRows) end-to-end on a real Postgres 16. Run in its OWN
// process: `bun test ./packages/db/test/effectivePolicyResolve.itest.ts`.
//
// Proves: (1) getScopeRows returns the platform-NULL defaults + the calling tenant's rows, and NEVER another
// tenant's rows (RLS); (2) resolving those rows yields the strictest-wins effective policy (platform default,
// tightened by org). resolvePolicyFromRows is imported from its FILE (not the @leadwolf/auth barrel) so the
// pure resolver loads without pulling the whole auth package — packages/db does not declare @leadwolf/auth.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AuthPolicy } from "@leadwolf/types";
import postgres from "postgres";
import { resolvePolicyFromRows } from "../../auth/src/policy.ts";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let dbmod: DbModule;

let tenantA = "";
let tenantB = "";

// The hardcoded platform floor the repository supplies (mirrors authPolicyRepository.DEFAULT_POLICY).
const FLOOR: AuthPolicy = {
  mfaEnforcement: "off",
  allowedMethods: ["password", "oauth", "magic_link", "sso", "passkey"],
  disableSocial: false,
  requireSso: false,
  ipAllowlist: [],
};

async function seedTenant(slug: string): Promise<string> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  return (t as { id: string }).id;
}

beforeAll(async () => {
  dbHandle = await startItestDb("effectivePolicyResolve");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  tenantA = await seedTenant("acme");
  tenantB = await seedTenant("globex");

  // Seed via the owner connection (RLS-exempt): a platform default + org rows for BOTH tenants (with tenant B's
  // set to a distinctive value that must never leak into tenant A's resolution).
  await admin`INSERT INTO auth_policies (scope, key, value) VALUES ('platform', 'mfa_enforcement', '"optional"'::jsonb)`;
  await admin`INSERT INTO auth_policies (scope, key, value) VALUES ('platform', 'session_timeout_seconds', '86400'::jsonb)`;
  await admin`INSERT INTO auth_policies (scope, tenant_id, key, value) VALUES ('org', ${tenantA}, 'mfa_enforcement', '"required"'::jsonb)`;
  await admin`INSERT INTO auth_policies (scope, tenant_id, key, value) VALUES ('org', ${tenantB}, 'require_sso', 'true'::jsonb)`;

  // env is set above, BEFORE the db singleton loads.
  dbmod = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("effective-policy resolve (DB read + RLS + strictest-wins)", () => {
  test("getScopeRows returns platform + own-tenant rows, never another tenant's", async () => {
    const rows = await dbmod.effectivePolicyRepository.getScopeRows({ tenantId: tenantA });
    const scopes = rows.map((r) => r.scope).sort();
    expect(scopes).toEqual(["org", "platform", "platform"]); // 2 platform defaults + tenant A's 1 org row
    // tenant B's org row (require_sso) must NOT be present — proven by no row carrying that key.
    expect(rows.some((r) => r.key === "require_sso")).toBe(false);
  });

  test("resolving tenant A: platform default (optional) tightened by org (required); platform timeout inherited", async () => {
    const rows = await dbmod.effectivePolicyRepository.getScopeRows({ tenantId: tenantA });
    const eff = resolvePolicyFromRows(rows, undefined, FLOOR);
    expect(eff.mfaEnforcement).toBe("required"); // org tightened the platform's "optional"
    expect(eff.sessionTimeoutSeconds).toBe(86400); // inherited from the platform default
    expect(eff.requireSso).toBe(false); // tenant B's requireSso never leaked in
  });

  test("resolving tenant B: its own org row (requireSso) applies; tenant A's mfa tighten does not", async () => {
    const rows = await dbmod.effectivePolicyRepository.getScopeRows({ tenantId: tenantB });
    const eff = resolvePolicyFromRows(rows, undefined, FLOOR);
    expect(eff.requireSso).toBe(true); // tenant B's own row
    expect(eff.mfaEnforcement).toBe("optional"); // only the PLATFORM default — A's "required" never reached B
  });

  test("upsertTenantKey inserts then UPDATES the same org key (onConflict), never duplicates", async () => {
    const [u] = await admin`INSERT INTO users (email) VALUES ('sec-admin@acme.test') RETURNING id`;
    const actor = (u as { id: string }).id;
    await admin`INSERT INTO tenant_members (tenant_id, user_id) VALUES (${tenantA}, ${actor})`;

    // insert
    await dbmod.effectivePolicyRepository.upsertTenantKey({
      tenantId: tenantA,
      scope: "org",
      key: "disable_social",
      value: true,
      actorUserId: actor,
    });
    let rows = await dbmod.effectivePolicyRepository.getScopeRows({ tenantId: tenantA });
    expect(rows.find((r) => r.key === "disable_social")?.value).toBe(true);

    // update the SAME (scope, tenant, workspace=NULL, key) → the onConflict path must UPDATE, not insert a dup.
    await dbmod.effectivePolicyRepository.upsertTenantKey({
      tenantId: tenantA,
      scope: "org",
      key: "disable_social",
      value: false,
      actorUserId: actor,
    });
    rows = await dbmod.effectivePolicyRepository.getScopeRows({ tenantId: tenantA });
    expect(rows.filter((r) => r.key === "disable_social").length).toBe(1); // single row — upsert, not insert
    expect(rows.find((r) => r.key === "disable_social")?.value).toBe(false); // value updated
  });
});
