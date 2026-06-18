// importTemplates.itest.ts — the G-IMP-3 (saved import mapping templates) Definition-of-Done proof, on a
// real Postgres 16 (10/14 §3.2): Testcontainers by default, or an external server via ITEST_DATABASE_URL
// (see itestDb.ts). Requires generated src/migrations (`bun run --filter @leadwolf/db generate`). Named
// *.itest.ts so default `bun test` skips it; run explicitly:
//   bun test packages/db/test/importTemplates.itest.ts
//
// Proves: (1) save a mapping as a template → it appears in the workspace list and findById returns its
// mapping (the "apply pre-fills the column map" path); (2) re-saving under the same name (any case) UPSERTs
// in place — never a duplicate; (3) per-workspace RLS isolation — workspace B cannot see, read-by-id, or
// delete workspace A's template, and creating same-named templates in two workspaces is allowed (the unique
// index is per-workspace); (4) RLS fails closed for the non-BYPASSRLS leadwolf_app role when the GUC is unset.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("../src/index.ts");

let dbHandle: ItestDb;
let db: Db;
let admin: ReturnType<typeof postgres>;
let appUrl: string;
let tenantA = "";
let tenantB = "";
let wsA = "";
let wsB = "";
let ownerA = "";

const MAPPING_A = {
  email: "Email",
  firstName: "First Name",
  lastName: "Last Name",
  accountName: "Company",
  accountDomain: "Domain",
};

async function seedWorkspace(
  slug: string,
): Promise<{ tenantId: string; workspaceId: string; ownerId: string }> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${t!.id}, ${u!.id}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${t!.id}, ${slug}, ${slug}, true, ${u!.id}) RETURNING id`;
  return { tenantId: t!.id, workspaceId: w!.id, ownerId: u!.id };
}

async function countTemplates(workspaceId: string): Promise<number> {
  const [r] = await admin`
    SELECT count(*)::int AS n FROM import_mapping_templates WHERE workspace_id = ${workspaceId}`;
  return (r as { n: number }).n;
}

beforeAll(async () => {
  dbHandle = await startItestDb("importTemplates");

  // Bind the db client to the test database BEFORE importing @leadwolf/db (its client reads env at import).
  process.env.DATABASE_URL = dbHandle.adminUrl;
  appUrl = dbHandle.appUrl;

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA, ownerId: ownerA } = await seedWorkspace("acme"));
  ({ tenantId: tenantB, workspaceId: wsB } = await seedWorkspace("globex"));

  db = await import("../src/index.ts");
}, 180_000);

afterAll(async () => {
  // Drain the @leadwolf/db singleton pool first — its open sockets otherwise keep the runner alive.
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("G-IMP-3 saved import mapping templates", () => {
  const repo = () => db.importMappingTemplateRepository;

  test("save → appears in the workspace list and findById returns its mapping (apply path)", async () => {
    const scope = { tenantId: tenantA, workspaceId: wsA };
    const saved = await repo().save(scope, {
      tenantId: tenantA,
      workspaceId: wsA,
      name: "Apollo export",
      mapping: MAPPING_A,
      createdByUserId: ownerA,
    });
    expect(saved.name).toBe("Apollo export");
    expect(saved.mapping).toEqual(MAPPING_A);

    const list = await repo().listByWorkspace(scope);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(saved.id);

    // The "apply" pre-fill: findById hands back the exact mapping to seed the column-mapper.
    const found = await repo().findById(scope, saved.id);
    expect(found?.mapping).toEqual(MAPPING_A);
    expect(await countTemplates(wsA)).toBe(1);
  });

  test("re-saving under the same name (case-insensitive) UPSERTs in place — no duplicate", async () => {
    const scope = { tenantId: tenantA, workspaceId: wsA };
    const newMapping = { ...MAPPING_A, jobTitle: "Title" };
    const updated = await repo().save(scope, {
      tenantId: tenantA,
      workspaceId: wsA,
      name: "apollo EXPORT", // different casing, same logical name
      mapping: newMapping,
      createdByUserId: ownerA,
    });
    // Still exactly one row in the workspace; the mapping was overwritten and the casing kept.
    expect(await countTemplates(wsA)).toBe(1);
    const found = await repo().findById(scope, updated.id);
    expect(found?.mapping).toEqual(newMapping);
    expect(found?.name).toBe("apollo EXPORT");
  });

  test("per-workspace RLS isolation: B cannot see, read, or delete A's template", async () => {
    const scopeA = { tenantId: tenantA, workspaceId: wsA };
    const scopeB = { tenantId: tenantB, workspaceId: wsB };
    const [aTemplate] = await repo().listByWorkspace(scopeA);
    expect(aTemplate).toBeDefined();

    // B's list is empty; A's id is invisible to B; B cannot delete A's row.
    expect(await repo().listByWorkspace(scopeB)).toHaveLength(0);
    expect(await repo().findById(scopeB, aTemplate!.id)).toBeNull();
    expect(await repo().deleteById(scopeB, aTemplate!.id)).toBe(false);
    // A's row survived B's delete attempt.
    expect(await countTemplates(wsA)).toBe(1);

    // The unique index is PER-WORKSPACE: B may create a same-named template of its own.
    await repo().save(scopeB, {
      tenantId: tenantB,
      workspaceId: wsB,
      name: "Apollo export",
      mapping: { email: "E-mail" },
      createdByUserId: null,
    });
    expect(await countTemplates(wsB)).toBe(1);
    // A is untouched by B's same-named save.
    expect(await countTemplates(wsA)).toBe(1);
  });

  test("A can delete its own template", async () => {
    const scopeA = { tenantId: tenantA, workspaceId: wsA };
    const [aTemplate] = await repo().listByWorkspace(scopeA);
    expect(await repo().deleteById(scopeA, aTemplate!.id)).toBe(true);
    expect(await countTemplates(wsA)).toBe(0);
  });

  test("RLS fails closed for leadwolf_app when the GUC is unset", async () => {
    const app = postgres(appUrl, { max: 1, onnotice: () => {} });
    try {
      const seenB = await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_workspace_id', ${wsB}, true)`;
        const [r] = await tx`SELECT count(*)::int AS n FROM import_mapping_templates`;
        return (r as { n: number }).n;
      });
      expect(seenB).toBe(1); // B's own same-named template from the isolation test

      const seenUnset = await app.begin(async (tx) => {
        const [r] = await tx`SELECT count(*)::int AS n FROM import_mapping_templates`;
        return (r as { n: number }).n;
      });
      expect(seenUnset).toBe(0);
    } finally {
      await app.end();
    }
  });
});
