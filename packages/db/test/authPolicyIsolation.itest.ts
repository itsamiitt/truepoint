// authPolicyIsolation.itest.ts — the cross-tenant isolation + platform-default write-guard proof for the
// Phase-1 effective-policy store `auth_policies` (doc 11 §3-4, doc 12 Phase 1). On a real Postgres 16
// (Testcontainers by default, or an external server via ITEST_DATABASE_URL). Run in its OWN process (the db
// client is a module singleton): `bun test ./packages/db/test/authPolicyIsolation.itest.ts`.
//
// auth_policies has a NULLABLE tenant_id — a NULL row is a PLATFORM DEFAULT. The RLS (rls/auth.sql) must give
// the app role (leadwolf_app, NON-BYPASSRLS) exactly:
//   READ  = its own tenant's rows + the platform (NULL) defaults (the resolver composes platform → org);
//   WRITE = ONLY its own tenant's rows — never a foreign tenant's, never a platform default.
// So the platform defaults are owner-only (withPlatformTx / the owner connection, which ENABLE-not-FORCE RLS
// leaves exempt). This itest drives the RLS with RAW SQL under both roles so the guarantee is proven at the
// boundary itself, independent of any repository/resolver layered on top later.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>; // owner / superuser connection — RLS-exempt (seeds every scope)
let app: ReturnType<typeof postgres>; // leadwolf_app — NON-BYPASSRLS, the role the RLS constrains

let tenantA = "";
let tenantB = "";

async function seedTenant(slug: string): Promise<string> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  return (t as { id: string }).id;
}

beforeAll(async () => {
  dbHandle = await startItestDb("authPolicyIsolation");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  app = postgres(dbHandle.appUrl, { max: 2, onnotice: () => {} });

  tenantA = await seedTenant("acme");
  tenantB = await seedTenant("globex");

  // Seed one row per scope via the owner connection (RLS-exempt): a PLATFORM default (tenant_id NULL) and an
  // ORG row for each tenant. Same key, so the resolver would later compose them.
  await admin`INSERT INTO auth_policies (scope, key, value) VALUES ('platform', 'mfa_enforcement', '"optional"'::jsonb)`;
  await admin`INSERT INTO auth_policies (scope, tenant_id, key, value) VALUES ('org', ${tenantA}, 'mfa_enforcement', '"required"'::jsonb)`;
  await admin`INSERT INTO auth_policies (scope, tenant_id, key, value) VALUES ('org', ${tenantB}, 'mfa_enforcement', '"optional"'::jsonb)`;
}, 180_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await dbHandle?.stop();
});

describe("auth_policies RLS: cross-tenant isolation + platform-default write-guard", () => {
  test("READ: tenant B sees its own org row + the platform default, but NEVER tenant A's org row", async () => {
    const rows = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantB}, true)`;
      return tx`SELECT scope, tenant_id FROM auth_policies ORDER BY scope`;
    });
    const scopes = rows.map((r) => (r as { scope: string }).scope).sort();
    expect(scopes).toEqual(["org", "platform"]); // exactly two: its org row + the platform default
    const tenantIds = rows.map((r) => (r as { tenant_id: string | null }).tenant_id);
    expect(tenantIds).toContain(null); // the platform default is visible
    expect(tenantIds).not.toContain(tenantA); // tenant A's org row is NOT
    for (const id of tenantIds) expect(id === null || id === tenantB).toBe(true);
  });

  test("READ: with NO tenant GUC, only the platform (NULL) default is visible — no tenant rows leak", async () => {
    const rows = await app.begin(async (tx) => {
      // no set_config → app.current_tenant_id is unset → NULLIF(...) is NULL → only `tenant_id IS NULL` matches
      return tx`SELECT tenant_id FROM auth_policies`;
    });
    expect(rows.length).toBe(1);
    expect((rows[0] as { tenant_id: string | null }).tenant_id).toBeNull();
  });

  test("WRITE CHECK: tenant B cannot INSERT a row stamped with tenant A's id", async () => {
    let blocked = false;
    try {
      await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantB}, true)`;
        await tx`INSERT INTO auth_policies (scope, tenant_id, key, value) VALUES ('org', ${tenantA}, 'evil', '"x"'::jsonb)`;
      });
    } catch {
      blocked = true;
    }
    expect(blocked).toBe(true);
  });

  test("WRITE CHECK: the app role cannot INSERT a PLATFORM default (NULL tenant_id) — owner-only", async () => {
    let blocked = false;
    try {
      await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantB}, true)`;
        await tx`INSERT INTO auth_policies (scope, key, value) VALUES ('platform', 'evil', '"x"'::jsonb)`;
      });
    } catch {
      blocked = true;
    }
    expect(blocked).toBe(true);
  });

  test("WRITE: tenant B CAN INSERT its own org row (the positive control)", async () => {
    const inserted = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantB}, true)`;
      const [r] = await tx`
        INSERT INTO auth_policies (scope, tenant_id, key, value)
        VALUES ('org', ${tenantB}, 'session_timeout_seconds', '3600'::jsonb) RETURNING id`;
      return r as { id: string };
    });
    expect(inserted.id).toBeTruthy();
  });
});
