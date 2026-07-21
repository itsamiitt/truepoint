// importDelta.itest.ts — P5 DELTA / incremental imports proof (import-and-data-model-redesign 08 §9 layer 3),
// on a real Postgres 16 (mirrors import.itest.ts's harness). Requires generated src/migrations
// (`bun run --filter @leadwolf/db generate`). Named *.itest.ts so default `bun test` skips it; run explicitly:
// `bun test packages/db/test/importDelta.itest.ts`.
//
// Proves the three things 08 §9's delta section pins (the honest thin version):
//   (1) LADDER PRECEDENCE — with `externalIdUpsert` on, a mapped `externalId` is the TOP dedup rung: it holds
//       a contact's identity ACROSS an email change (upsert-on-external-id), where the shipped email→linkedin→
//       sales-nav ladder alone would fork a NEW contact. Contrasted against the SAME rows with the option OFF.
//   (2) CONTENT-HASH re-import SKIP still governs delta re-imports (08 §9 layer 1) — an identical re-run is a
//       no-op even with the external-id option on (the external stamp never breaks idempotency).
//   (3) GATE-OFF BYTE-IDENTITY — with the option absent/false the engine NEVER reads or writes external_id and
//       runs the shipped ladder exactly (the external_id column stays NULL even when an externalId is mapped).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type RunImportFn = typeof import("../../core/src/index.ts")["runImport"];

let dbHandle: ItestDb;
let runImport: RunImportFn;
let admin: ReturnType<typeof postgres>;
let tenantOn = "";
let wsOn = "";
let ownerOn = "";
let tenantOff = "";
let wsOff = "";

// Maps the caller's stable key + the intrinsic identity (an import row still needs an email/linkedin/sales-nav
// key to LAND — the overlay has no external-id-only contact; 08 §9 caveat, doc 16).
const MAPPING = {
  externalId: "ExternalId",
  email: "Email",
  firstName: "First Name",
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

async function countContacts(workspaceId: string): Promise<number> {
  const [r] =
    await admin`SELECT count(*)::int AS n FROM contacts WHERE workspace_id = ${workspaceId}`;
  return (r as { n: number }).n;
}

/** external_id value(s) live in the workspace (order-stable for assertions). */
async function externalIds(workspaceId: string): Promise<Array<string | null>> {
  const rows = await admin`
    SELECT external_id FROM contacts WHERE workspace_id = ${workspaceId} ORDER BY created_at`;
  return (rows as Array<{ external_id: string | null }>).map((r) => r.external_id);
}

beforeAll(async () => {
  dbHandle = await startItestDb("import-delta");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantOn, workspaceId: wsOn, ownerId: ownerOn } = await seedWorkspace("delta-on"));
  ({ tenantId: tenantOff, workspaceId: wsOff } = await seedWorkspace("delta-off"));

  ({ runImport } = await import("../../core/src/index.ts"));
}, 180_000);

afterAll(async () => {
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("P5 delta imports — external_id upsert rung (08 §9 layer 3)", () => {
  test("external-id rung PRECEDES the email rung: it holds identity across an email change", async () => {
    // Row 1 (delta on): create contact A, external_id stamped.
    const s1 = await runImport({
      scope: { tenantId: tenantOn, workspaceId: wsOn },
      importedByUserId: ownerOn,
      sourceName: "manual",
      mapping: MAPPING,
      externalIdUpsert: true,
      rows: [{ ExternalId: "EXT-A", Email: "alice@acme.com", "First Name": "Alice", Domain: "acme.com" }],
    });
    expect(s1.created).toBe(1);
    expect(await countContacts(wsOn)).toBe(1);
    expect(await externalIds(wsOn)).toEqual(["EXT-A"]);

    // Row 2 (delta on): SAME external key, DIFFERENT email (held by nobody). The external rung matches A FIRST
    // — so this UPDATES A (upsert-on-external-id), it does NOT fork a new contact the way the email rung would.
    const s2 = await runImport({
      scope: { tenantId: tenantOn, workspaceId: wsOn },
      importedByUserId: ownerOn,
      sourceName: "manual",
      mapping: MAPPING,
      externalIdUpsert: true,
      conflictPolicy: "overwrite", // create_and_update: a match UPDATES
      rows: [{ ExternalId: "EXT-A", Email: "alice.new@acme.com", "First Name": "Alice", Domain: "acme.com" }],
    });
    expect(s2.created).toBe(0);
    expect(s2.matched).toBe(1);
    expect(await countContacts(wsOn)).toBe(1); // still ONE contact — external key held identity
    expect(await externalIds(wsOn)).toEqual(["EXT-A"]);
  });

  test("GATE-OFF byte-identity: option absent ⇒ the email change FORKS a new contact, external_id stays NULL", async () => {
    // The SAME two rows as above, but with the external-id option OFF (the shipped ladder only). Row 1 creates;
    // row 2's changed email matches nobody by the email rung ⇒ a SECOND contact is created. The external_id
    // column is NEVER written (both rows land with NULL external_id) — byte-identical to today.
    const s1 = await runImport({
      scope: { tenantId: tenantOff, workspaceId: wsOff },
      sourceName: "manual",
      mapping: MAPPING,
      rows: [{ ExternalId: "EXT-A", Email: "bob@globex.com", "First Name": "Bob", Domain: "globex.com" }],
    });
    expect(s1.created).toBe(1);

    const s2 = await runImport({
      scope: { tenantId: tenantOff, workspaceId: wsOff },
      sourceName: "manual",
      mapping: MAPPING,
      conflictPolicy: "overwrite",
      rows: [{ ExternalId: "EXT-A", Email: "bob.new@globex.com", "First Name": "Bob", Domain: "globex.com" }],
    });
    expect(s2.created).toBe(1); // forked — the email rung found no match
    expect(await countContacts(wsOff)).toBe(2);
    expect(await externalIds(wsOff)).toEqual([null, null]); // gate-off never writes external_id
  });

  test("content-hash re-import SKIP still governs a delta re-run (08 §9 layer 1)", async () => {
    // Re-run row 1 into the delta-on workspace VERBATIM (same external key + same email + same scalars ⇒ same
    // content hash). The shipped source_imports content-hash idempotency skips it — the external stamp never
    // breaks it: no new contact, no update, counted `skipped`.
    const before = await countContacts(wsOn);
    const s = await runImport({
      scope: { tenantId: tenantOn, workspaceId: wsOn },
      importedByUserId: ownerOn,
      sourceName: "manual",
      mapping: MAPPING,
      externalIdUpsert: true,
      rows: [{ ExternalId: "EXT-A", Email: "alice@acme.com", "First Name": "Alice", Domain: "acme.com" }],
    });
    expect(s.skipped).toBe(1);
    expect(s.created).toBe(0);
    expect(s.matched).toBe(0);
    expect(await countContacts(wsOn)).toBe(before);
  });

  test("a fresh external key on a delta-on import CREATES and STAMPS the key", async () => {
    const s = await runImport({
      scope: { tenantId: tenantOn, workspaceId: wsOn },
      importedByUserId: ownerOn,
      sourceName: "manual",
      mapping: MAPPING,
      externalIdUpsert: true,
      rows: [{ ExternalId: "EXT-Z", Email: "zed@acme.com", "First Name": "Zed", Domain: "acme.com" }],
    });
    expect(s.created).toBe(1);
    // Both external keys now live in the workspace (the new one stamped on create).
    expect((await externalIds(wsOn)).sort()).toEqual(["EXT-A", "EXT-Z"]);
  });
});
