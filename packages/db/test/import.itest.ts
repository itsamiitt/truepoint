// import.itest.ts — the M1 Definition-of-Done proof, on a real Postgres 16 (10/14 §3.2): Testcontainers by
// default, or an external server via ITEST_DATABASE_URL (see itestDb.ts). Requires generated src/migrations
// (`bun run --filter @leadwolf/db generate`). Named *.itest.ts so default `bun test` skips it; run
// explicitly: `bun test packages/db/test/import.itest.ts`.
//
// Proves: (1) per-workspace dedup → one contact per identity; (2) the same payload in another workspace is
// a separate copy, the first untouched; (3) re-import is idempotent; (4) RLS isolates workspaces for the
// non-BYPASSRLS leadwolf_app role and fails closed when the GUC is unset.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type RunImportFn = typeof import("../../core/src/index.ts")["runImport"];

let dbHandle: ItestDb;
let runImport: RunImportFn;
let admin: ReturnType<typeof postgres>;
let appUrl: string;
let tenantA = "";
let tenantB = "";
let wsA = "";
let wsB = "";
let ownerA = "";

const MAPPING = {
  email: "Email",
  firstName: "First Name",
  lastName: "Last Name",
  accountName: "Company",
  accountDomain: "Domain",
};

// 5 rows, 3 distinct identities: 3 "jane" variants (case + plus-tag) collapse to one contact.
const DUPES = [
  {
    Email: "jane@acme.com",
    "First Name": "Jane",
    "Last Name": "Doe",
    Company: "Acme",
    Domain: "acme.com",
  },
  {
    Email: "JANE@acme.com",
    "First Name": "Jane",
    "Last Name": "Doe",
    Company: "Acme",
    Domain: "acme.com",
  },
  {
    Email: "jane+sales@acme.com",
    "First Name": "Jane",
    "Last Name": "Doe",
    Company: "Acme",
    Domain: "acme.com",
  },
  {
    Email: "john@acme.com",
    "First Name": "John",
    "Last Name": "Roe",
    Company: "Acme",
    Domain: "acme.com",
  },
  {
    Email: "mary@globex.com",
    "First Name": "Mary",
    "Last Name": "Sue",
    Company: "Globex",
    Domain: "globex.com",
  },
];

// Global-identity seeding (ADR-0019): users is global; org membership lives in tenant_members.
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

async function countContacts(workspaceId: string): Promise<number> {
  const [r] =
    await admin`SELECT count(*)::int AS n FROM contacts WHERE workspace_id = ${workspaceId}`;
  return (r as { n: number }).n;
}

beforeAll(async () => {
  dbHandle = await startItestDb("import");

  // Bind the app's config/db client to the test database BEFORE importing @leadwolf/core.
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  appUrl = dbHandle.appUrl;

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA, ownerId: ownerA } = await seedWorkspace("acme"));
  ({ tenantId: tenantB, workspaceId: wsB } = await seedWorkspace("globex"));

  ({ runImport } = await import("../../core/src/index.ts"));
}, 180_000);

afterAll(async () => {
  // Drain the @leadwolf/db singleton pool first — its open sockets otherwise keep the runner alive.
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("M1 import & dedup DoD", () => {
  test("per-workspace dedup → one contact per identity", async () => {
    const summary = await runImport({
      scope: { tenantId: tenantA, workspaceId: wsA },
      importedByUserId: ownerA,
      sourceName: "manual",
      sourceFile: "dupes.csv",
      mapping: MAPPING,
      rows: DUPES,
    });
    expect(summary.created).toBe(3);
    expect(summary.matched).toBe(2);
    expect(summary.skipped).toBe(0);
    expect(summary.errors).toHaveLength(0);
    expect(await countContacts(wsA)).toBe(3);
  });

  test("same payload into a second workspace is a separate copy; the first is untouched", async () => {
    const summary = await runImport({
      scope: { tenantId: tenantB, workspaceId: wsB },
      sourceName: "manual",
      mapping: MAPPING,
      rows: DUPES,
    });
    expect(summary.created).toBe(3);
    expect(await countContacts(wsB)).toBe(3);
    expect(await countContacts(wsA)).toBe(3);
  });

  test("re-importing identical rows is idempotent (all skipped)", async () => {
    const summary = await runImport({
      scope: { tenantId: tenantA, workspaceId: wsA },
      sourceName: "manual",
      mapping: MAPPING,
      rows: DUPES,
    });
    expect(summary.created).toBe(0);
    expect(summary.matched).toBe(0);
    expect(summary.skipped).toBe(5);
    expect(await countContacts(wsA)).toBe(3);
  });

  test("RLS isolates workspaces for leadwolf_app and fails closed when the GUC is unset", async () => {
    const app = postgres(appUrl, { max: 1, onnotice: () => {} });
    try {
      const seenA = await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_workspace_id', ${wsA}, true)`;
        const [r] = await tx`SELECT count(*)::int AS n FROM contacts`;
        return (r as { n: number }).n;
      });
      expect(seenA).toBe(3);

      const seenUnset = await app.begin(async (tx) => {
        const [r] = await tx`SELECT count(*)::int AS n FROM contacts`;
        return (r as { n: number }).n;
      });
      expect(seenUnset).toBe(0);
    } finally {
      await app.end();
    }
  });
});
