// authAllowedOriginsIsolation.itest.ts — the cross-tenant isolation + platform-default write-guard proof for
// the Phase-1 managed callback-origin store `auth_allowed_origins` (doc 11 §2, AUTH-036). On a real Postgres 16
// (Testcontainers by default, or ITEST_DATABASE_URL). Run in its OWN process:
// `bun test ./packages/db/test/authAllowedOriginsIsolation.itest.ts`.
//
// Same nullable-tenant RLS as auth_policies: a NULL row is a PLATFORM-wide managed origin. The app role
// (leadwolf_app, NON-BYPASSRLS) must get: READ = its own tenant's rows + the platform (NULL) rows (the resolver
// unions env-floor ∪ platform ∪ org); WRITE = ONLY its own tenant's rows — never a foreign tenant's, never a
// platform origin (those are owner-only, withPlatformTx). Driven with RAW SQL under both roles.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type DbModule = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>; // owner — RLS-exempt (seeds every scope)
let app: ReturnType<typeof postgres>; // leadwolf_app — the role RLS constrains
let dbmod: DbModule;

let tenantA = "";
let tenantB = "";
let actorB = "";

async function seedTenant(slug: string): Promise<string> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  return (t as { id: string }).id;
}

beforeAll(async () => {
  dbHandle = await startItestDb("authAllowedOriginsIsolation");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  app = postgres(dbHandle.appUrl, { max: 2, onnotice: () => {} });

  tenantA = await seedTenant("acme");
  tenantB = await seedTenant("globex");

  // A platform-wide managed origin + one org origin per tenant (owner connection, RLS-exempt).
  await admin`INSERT INTO auth_allowed_origins (scope, origin) VALUES ('platform', 'https://portal.truepoint.in')`;
  await admin`INSERT INTO auth_allowed_origins (scope, tenant_id, origin) VALUES ('org', ${tenantA}, 'https://acme.example')`;
  await admin`INSERT INTO auth_allowed_origins (scope, tenant_id, origin) VALUES ('org', ${tenantB}, 'https://globex.example')`;

  // A user for the repository write path (audit FK) + env set before the db singleton loads.
  const [u] = await admin`INSERT INTO users (email) VALUES ('sec@globex.test') RETURNING id`;
  actorB = (u as { id: string }).id;
  await admin`INSERT INTO tenant_members (tenant_id, user_id) VALUES (${tenantB}, ${actorB})`;
  dbmod = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  await dbmod?.closeDb();
  await app?.end();
  await admin?.end();
  await dbHandle?.stop();
});

describe("auth_allowed_origins RLS: isolation + platform write-guard", () => {
  test("READ: tenant A sees its own origin + the platform origin, never tenant B's", async () => {
    const rows = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantA}, true)`;
      return tx`SELECT origin FROM auth_allowed_origins ORDER BY origin`;
    });
    const origins = rows.map((r) => (r as { origin: string }).origin);
    expect(origins).toContain("https://portal.truepoint.in"); // platform default
    expect(origins).toContain("https://acme.example"); // own
    expect(origins).not.toContain("https://globex.example"); // tenant B's — never
  });

  test("READ: with NO tenant GUC, only the platform origin is visible", async () => {
    const rows = await app.begin(async (tx) => tx`SELECT origin FROM auth_allowed_origins`);
    expect(rows.length).toBe(1);
    expect((rows[0] as { origin: string }).origin).toBe("https://portal.truepoint.in");
  });

  test("WRITE CHECK: tenant B cannot INSERT a row stamped with tenant A's id", async () => {
    let blocked = false;
    try {
      await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantB}, true)`;
        await tx`INSERT INTO auth_allowed_origins (scope, tenant_id, origin) VALUES ('org', ${tenantA}, 'https://evil.example')`;
      });
    } catch {
      blocked = true;
    }
    expect(blocked).toBe(true);
  });

  test("WRITE CHECK: the app role cannot INSERT a PLATFORM origin (NULL tenant) — owner-only", async () => {
    let blocked = false;
    try {
      await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${tenantB}, true)`;
        await tx`INSERT INTO auth_allowed_origins (scope, origin) VALUES ('platform', 'https://evil.example')`;
      });
    } catch {
      blocked = true;
    }
    expect(blocked).toBe(true);
  });

  test("WRITE: tenant B CAN INSERT its own org origin (positive control)", async () => {
    const inserted = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${tenantB}, true)`;
      const [r] = await tx`
        INSERT INTO auth_allowed_origins (scope, tenant_id, origin)
        VALUES ('org', ${tenantB}, 'https://globex-staging.example') RETURNING id`;
      return r as { id: string };
    });
    expect(inserted.id).toBeTruthy();
  });

  test("repository: addTenantOrigin (idempotent) → getScopeOrigins reflects it → removeTenantOrigin", async () => {
    const origin = "https://globex-app.example";
    await dbmod.authAllowedOriginsRepository.addTenantOrigin({
      tenantId: tenantB,
      origin,
      actorUserId: actorB,
    });
    // idempotent — a duplicate add must not create a second row (onConflictDoNothing)
    await dbmod.authAllowedOriginsRepository.addTenantOrigin({
      tenantId: tenantB,
      origin,
      actorUserId: actorB,
    });
    let rows = await dbmod.authAllowedOriginsRepository.getScopeOrigins({ tenantId: tenantB });
    expect(rows.filter((r) => r.origin === origin).length).toBe(1); // exactly one
    expect(rows.some((r) => r.origin === "https://portal.truepoint.in")).toBe(true); // platform still visible

    await dbmod.authAllowedOriginsRepository.removeTenantOrigin({
      tenantId: tenantB,
      origin,
      actorUserId: actorB,
    });
    rows = await dbmod.authAllowedOriginsRepository.getScopeOrigins({ tenantId: tenantB });
    expect(rows.some((r) => r.origin === origin)).toBe(false); // removed
  });
});
