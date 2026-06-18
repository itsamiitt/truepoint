// featureFlags.itest.ts — proves the platform feature-flag system (13 §3.5, ADR-0011) against real
// Postgres 16 (Testcontainers by default, or an external server via ITEST_DATABASE_URL — see itestDb.ts).
// Covers the three acceptance bars for this unit:
//   1. EVALUATION — per-tenant override else global default else flag default; unknown flag fails closed.
//   2. AUDITED WRITES — admin toggles run through withPlatformTx, which writes a platform_audit_log row in
//      the same transaction (the existing platform-audit path).
//   3. ACCESS MODEL / ISOLATION — feature_flags is platform-managed: the non-BYPASSRLS app role
//      (leadwolf_app, used by withTenantTx) may READ global flags but can NEVER write them, and reads ONLY
//      its OWN tenant's overrides — never another tenant's.
// Run in its OWN process (the db client is a module singleton):
//   bun test ./packages/db/test/featureFlags.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("@leadwolf/db");
type Core = typeof import("@leadwolf/core");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let db: Db;
let core: Core;
let tenantA = "";
let tenantB = "";
let adminUserId = "";

async function seedTenant(slug: string): Promise<string> {
  const [t] = await admin`
    INSERT INTO tenants (name, slug, reveal_credit_balance) VALUES (${slug}, ${slug}, 10) RETURNING id`;
  return (t as { id: string }).id;
}

const actor = () => ({ userId: adminUserId, ip: "127.0.0.1" });

beforeAll(async () => {
  dbHandle = await startItestDb("feature-flags");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  // platform_audit_log is provisioned by bootstrapAdmin/the admin track, not by applyMigrations — create it
  // here so withPlatformTx (which writes a row per call) works. Mirrors bootstrapAdmin.ts's self-heal DDL.
  await admin`
    CREATE TABLE IF NOT EXISTS platform_audit_log (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
      actor_user_id uuid NOT NULL,
      action text NOT NULL,
      target_type text,
      target_id text,
      tenant_id uuid,
      workspace_id uuid,
      ip text,
      metadata jsonb,
      occurred_at timestamptz NOT NULL DEFAULT now()
    )`;

  const [u] = await admin`INSERT INTO users (email) VALUES ('staff@platform.test') RETURNING id`;
  adminUserId = (u as { id: string }).id;
  tenantA = await seedTenant("acme");
  tenantB = await seedTenant("globex");

  db = await import("@leadwolf/db");
  core = await import("@leadwolf/core");
}, 180_000);

afterAll(async () => {
  await db.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

const auditCount = async (action: string): Promise<number> => {
  const [r] =
    await admin`SELECT count(*)::int AS n FROM platform_audit_log WHERE action = ${action}`;
  return (r as { n: number }).n;
};

describe("feature flags — definition + audited toggles (withPlatformTx)", () => {
  test("a flag can be defined and toggled globally, each write audited", async () => {
    const before = await auditCount("feature_flag.set");

    await db.withPlatformTx(actor(), "feature_flag.set", (tx) =>
      db.featureFlagRepository.upsert(tx, {
        key: "bulk_enrich",
        description: "Bulk enrichment beta",
        defaultEnabled: false,
      }),
    );
    await db.withPlatformTx(actor(), "feature_flag.set", (tx) =>
      db.featureFlagRepository.setGlobal(tx, "bulk_enrich", true),
    );

    const [flag] = await admin`SELECT global_enabled FROM feature_flags WHERE key = 'bulk_enrich'`;
    expect((flag as { global_enabled: boolean }).global_enabled).toBe(true);
    // Two audited platform writes happened in the same transactions as the changes.
    expect(await auditCount("feature_flag.set")).toBe(before + 2);
  });
});

describe("feature flags — evaluation precedence for a tenant", () => {
  test("per-tenant override else global default else flag default; unknown → off", async () => {
    // global off, default on  → enabled via default
    await db.withPlatformTx(actor(), "feature_flag.set", (tx) =>
      db.featureFlagRepository.upsert(tx, { key: "f_default_on", defaultEnabled: true }),
    );
    // global on               → enabled via global
    await db.withPlatformTx(actor(), "feature_flag.set", async (tx) => {
      await db.featureFlagRepository.upsert(tx, { key: "f_global", defaultEnabled: false });
      await db.featureFlagRepository.setGlobal(tx, "f_global", true);
    });
    // global on, but tenant A overrides OFF → disabled for A, enabled for B
    await db.withPlatformTx(actor(), "feature_flag.set", async (tx) => {
      await db.featureFlagRepository.upsert(tx, { key: "f_override", defaultEnabled: false });
      await db.featureFlagRepository.setGlobal(tx, "f_override", true);
      await db.featureFlagRepository.setTenantOverride(tx, "f_override", tenantA, false);
    });

    // Evaluate for tenant A under the scoped app-role path (withTenantTx).
    const flagsA = await db.withTenantTx({ tenantId: tenantA }, (tx) =>
      core.evaluateFlagsForTenant(tx, tenantA),
    );
    expect(flagsA.f_default_on).toEqual({
      key: "f_default_on",
      enabled: true,
      source: "default",
    });
    expect(flagsA.f_global).toEqual({ key: "f_global", enabled: true, source: "global" });
    expect(flagsA.f_override).toEqual({
      key: "f_override",
      enabled: false,
      source: "tenant_override",
    });

    // Tenant B has no override → f_override resolves via global (on).
    const evalB = await db.withTenantTx({ tenantId: tenantB }, (tx) =>
      core.evaluateFlagForTenant(tx, tenantB, "f_override"),
    );
    expect(evalB).toEqual({ key: "f_override", enabled: true, source: "global" });

    // Unknown flag fails closed.
    const ghost = await db.withTenantTx({ tenantId: tenantA }, (tx) =>
      core.evaluateFlagForTenant(tx, tenantA, "does_not_exist"),
    );
    expect(ghost).toEqual({ key: "does_not_exist", enabled: false, source: "unknown" });
  });
});

describe("feature flags — access model + tenant isolation (RLS)", () => {
  test("the app role can READ global flags but can NEVER write them", async () => {
    // Seed with global_enabled = true so a blocked flip-to-false is provable by the unchanged value.
    await db.withPlatformTx(actor(), "feature_flag.set", async (tx) => {
      await db.featureFlagRepository.upsert(tx, { key: "readable", defaultEnabled: true });
      await db.featureFlagRepository.setGlobal(tx, "readable", true);
    });

    // Read under the non-BYPASSRLS app role succeeds (global defaults must be evaluable in-request).
    const seen = await db.withTenantTx({ tenantId: tenantA }, (tx) =>
      db.featureFlagRepository.getGlobal(tx, "readable"),
    );
    expect(seen?.globalEnabled).toBe(true);

    // A write under the app role is blocked by FORCE RLS + no write policy: the UPDATE matches zero rows
    // (RLS filters it out), so setGlobal reports "not found" (false) and the row is UNCHANGED. INSERTs
    // (the override case below) are rejected outright; UPDATEs are silently filtered to a no-op — either
    // way the app role cannot mutate a platform flag.
    const wrote = await db.withTenantTx({ tenantId: tenantA }, (tx) =>
      db.featureFlagRepository.setGlobal(tx, "readable", false),
    );
    expect(wrote).toBe(false);
    const [row] = await admin`SELECT global_enabled FROM feature_flags WHERE key = 'readable'`;
    expect((row as { global_enabled: boolean }).global_enabled).toBe(true);
  });

  test("a tenant reads ONLY its own overrides — never another tenant's", async () => {
    await db.withPlatformTx(actor(), "feature_flag.set", async (tx) => {
      await db.featureFlagRepository.upsert(tx, { key: "iso", defaultEnabled: false });
      await db.featureFlagRepository.setTenantOverride(tx, "iso", tenantA, true);
      await db.featureFlagRepository.setTenantOverride(tx, "iso", tenantB, false);
    });

    // Tenant A's scoped read sees only A's override row.
    const overridesA = await db.withTenantTx({ tenantId: tenantA }, (tx) =>
      db.featureFlagRepository.overridesForTenant(tx, tenantA),
    );
    expect(overridesA.map((o) => o.tenantId)).toEqual([tenantA]);

    // Even if tenant A asks for tenant B's overrides, RLS exposes nothing (cross-tenant read is empty).
    const leak = await db.withTenantTx({ tenantId: tenantA }, (tx) =>
      db.featureFlagRepository.overridesForTenant(tx, tenantB),
    );
    expect(leak).toEqual([]);

    // The app role cannot INSERT an override either (platform-managed). Use a flag with NO existing override
    // for tenant A so this is a genuine INSERT — FORCE RLS + no INSERT policy rejects it outright.
    await db.withPlatformTx(actor(), "feature_flag.set", (tx) =>
      db.featureFlagRepository.upsert(tx, { key: "iso_insert", defaultEnabled: false }),
    );
    await expect(
      db.withTenantTx({ tenantId: tenantA }, (tx) =>
        db.featureFlagRepository.setTenantOverride(tx, "iso_insert", tenantA, true),
      ),
    ).rejects.toThrow();
    // And the row truly did not land.
    const [cnt] = await admin`
      SELECT count(*)::int AS n FROM tenant_feature_flags WHERE flag_key = 'iso_insert'`;
    expect((cnt as { n: number }).n).toBe(0);
  });
});
