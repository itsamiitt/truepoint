// importPinRespect.itest.ts — PLAN_03 §1.4 proof: the import-overwrite path RESPECTS the field-provenance pin
// (the Phase-3 overlay) and STAMPS `import:<source>` provenance on the scalars it writes. On a real Postgres 16
// (Testcontainers by default, or an external server via ITEST_DATABASE_URL — see itestDb.ts). Requires the
// generated src/migrations (`bun run --filter @leadwolf/db generate`). Named *.itest.ts so default `bun test`
// skips it; run explicitly: `bun test packages/db/test/importPinRespect.itest.ts`.
//
// Proves, end to end through `runImport({ conflictPolicy: 'overwrite' })`:
//   1. a contact lands with job_title='Old' / department='Old' (created via a first import, so its
//      email_blind_index matches what a re-import derives — same identity key, guaranteed re-match);
//   2. the user PINS jobTitle via editContactFields (sets {src:'user_edit', pin:true});
//   3. a second import with the SAME identity key sets jobTitle='Imported' + department='Imported'
//      under `overwrite`;
//   4. job_title is STILL 'Corrected' (pinned — the import did NOT overwrite the human correction);
//      department = 'Imported' (unpinned — overwritten); field_provenance->'department'->>'src' starts
//      with 'import:'; field_provenance->'jobTitle'->>'pin' is still 'true'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

// Import via the RELATIVE core barrel (NOT @leadwolf/core) — db→core is a build cycle (see import.itest.ts).
type RunImportFn = typeof import("../../core/src/index.ts")["runImport"];
type EditContactFieldsFn = typeof import("../../core/src/index.ts")["editContactFields"];

let dbHandle: ItestDb;
let runImport: RunImportFn;
let editContactFields: EditContactFieldsFn;
let admin: ReturnType<typeof postgres>;
let tenantA = "";
let wsA = "";
let ownerA = "";

const MAPPING = {
  email: "Email",
  firstName: "First Name",
  lastName: "Last Name",
  jobTitle: "Title",
  department: "Dept",
};

// Global-identity seeding (ADR-0019): users is global; org membership lives in tenant_members. Mirrors
// import.itest.ts::seedWorkspace.
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

interface ContactRow {
  id: string;
  job_title: string | null;
  department: string | null;
  field_provenance: Record<string, { src?: string; pin?: boolean }>;
}

async function readContact(workspaceId: string): Promise<ContactRow> {
  const [r] = await admin`
    SELECT id, job_title, department, field_provenance
    FROM contacts WHERE workspace_id = ${workspaceId} LIMIT 1`;
  return r as unknown as ContactRow;
}

beforeAll(async () => {
  dbHandle = await startItestDb("import_pin_respect");

  // Bind the app's config/db client to the test database BEFORE importing @leadwolf/core. The blind-index key
  // must be set so a re-import derives the SAME email_blind_index → the second import re-matches the seeded row.
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA, ownerId: ownerA } = await seedWorkspace("acme"));

  ({ runImport, editContactFields } = await import("../../core/src/index.ts"));
}, 180_000);

afterAll(async () => {
  // Drain the @leadwolf/db singleton pool first — its open sockets otherwise keep the runner alive.
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("PLAN_03 §1.4 — import overwrite respects the field-provenance pin", () => {
  test("a pinned scalar survives an overwrite import; an unpinned scalar is overwritten + stamped import:*", async () => {
    const scope = { tenantId: tenantA, workspaceId: wsA };

    // 1) Land the contact via a FIRST import so its email_blind_index is exactly what a re-import re-derives
    //    (same identity key → guaranteed re-match). Starts with job_title='Old', department='Old'.
    const first = await runImport({
      scope,
      importedByUserId: ownerA,
      sourceName: "manual",
      mapping: MAPPING,
      conflictPolicy: "overwrite",
      rows: [
        {
          Email: "pin@acme.com",
          "First Name": "Pinny",
          "Last Name": "McPin",
          Title: "Old",
          Dept: "Old",
        },
      ],
    });
    expect(first.created).toBe(1);

    const seeded = await readContact(wsA);
    expect(seeded.job_title).toBe("Old");
    expect(seeded.department).toBe("Old");

    // 2) PIN jobTitle via a user hand-edit (sets {src:'user_edit', pin:true}). department stays UNPINNED.
    await editContactFields(scope, seeded.id, { jobTitle: "Corrected" }, ownerA);

    const pinned = await readContact(wsA);
    expect(pinned.job_title).toBe("Corrected");
    expect(pinned.field_provenance.jobTitle?.pin).toBe(true);

    // 3) Re-import with the SAME identity key under `overwrite`: jobTitle='Imported', department='Imported'.
    const second = await runImport({
      scope,
      importedByUserId: ownerA,
      sourceName: "manual",
      mapping: MAPPING,
      conflictPolicy: "overwrite",
      rows: [
        {
          Email: "pin@acme.com",
          "First Name": "Pinny",
          "Last Name": "McPin",
          Title: "Imported",
          Dept: "Imported",
        },
      ],
    });
    expect(second.matched).toBe(1);
    expect(second.created).toBe(0);

    // 4) Assert via admin: pinned jobTitle survived; unpinned department was overwritten + stamped import:*.
    const after = await readContact(wsA);
    expect(after.job_title).toBe("Corrected"); // pinned — import did NOT overwrite the human correction
    expect(after.department).toBe("Imported"); // unpinned — overwritten by the import
    expect(after.field_provenance.department?.src?.startsWith("import:")).toBe(true);
    expect(after.field_provenance.jobTitle?.pin).toBe(true); // pin descriptor left untouched
  });
});
