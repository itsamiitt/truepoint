// fieldProvenancePin.itest.ts — the behavioural proof of the overlay field-provenance PIN (PLAN_03 §1.4
// overlay merge / §3.1 descriptor, Phase 3). Where fieldProvenance.test.ts proves the PURE planFieldWrite /
// planUserEdit merge in isolation, THIS file proves the END-TO-END overlay invariant against a real Postgres:
// a HUMAN CORRECTION IS SACROSANCT. The pin SETTER (editContactFields) stamps {src:'user_edit', pin:true} on
// an edited scalar, and a SUBSEQUENT provider enrichment (enrichContact, fed an INJECTED fake provider that
// returns jobTitle + department) leaves the pinned field — value AND descriptor — untouched, while still
// overwriting the UNPINNED field and recording its own `provider:` provenance. On a real Postgres 16
// (Testcontainers by default, or an external server via ITEST_DATABASE_URL — see itestDb.ts). Run in its OWN
// process (the db client + the per-process waterfall breakers are module singletons):
//   `bun test ./packages/db/test/fieldProvenancePin.itest.ts`
//
// Core fns (enrichContact, editContactFields, resetBreakers) are imported via the RELATIVE core barrel
// (../../core/src/index.ts), NOT as a db dep — importing @leadwolf/core into a packages/db test would create a
// build cycle (db ← core ← db). The contact + tenant are seeded via the privileged admin connection; the
// enrich/edit paths run through withTenantTx (RLS) exactly as production does.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");
// The provider contract — a TYPE-only import from the same relative core barrel (no runtime dep / build cycle).
type EnrichmentProvider = import("../../core/src/index.ts").EnrichmentProvider;

// The fake provider is named "zoominfo" so its name is a valid `sourceName` enum member — enrichContact then
// appends a source_imports provenance row AND stamps the field_provenance descriptor `src:'provider:zoominfo'`
// (a non-enum name would silently skip the source_imports append; the overlay/pin proof would still hold, but
// "zoominfo" exercises the full persist path).
const PROVIDER_NAME = "zoominfo";

// A fixed email blind index — an opaque HMAC dedup key for this test, never decoded.
const EMAIL_BI = new Uint8Array([10, 20, 30, 40]);
// A fixed AES-GCM ciphertext placeholder — getContactForReveal hands `email_enc` to core for in-tx decryption,
// but the fake provider returns jobTitle/department only (no email), so the ciphertext is never decrypted here.
// It exists solely so the enrich subject HAS an email facet (a realistic enrich subject), not to be read back.
const EMAIL_ENC = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let core: Core;
type Db = typeof import("@leadwolf/db");
let db: Db;

let tenantA = "";
let wsA = "";
let ownerA = "";
let tenantB = "";
let wsB = "";
let ownerB = "";
let contactId = "";
let contactB = "";

async function seedUser(email: string): Promise<string> {
  const [u] = await admin`INSERT INTO users (email) VALUES (${email}) RETURNING id`;
  return (u as { id: string }).id;
}

async function seedTenantWorkspace(
  slug: string,
): Promise<{ tenantId: string; workspaceId: string; ownerId: string }> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const tenantId = (t as { id: string }).id;
  const ownerId = await seedUser(`owner@${slug}.test`);
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantId}, ${ownerId}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, ${slug}, ${slug}, true, ${ownerId}) RETURNING id`;
  return { tenantId, workspaceId: (w as { id: string }).id, ownerId };
}

/**
 * A contact with the OLD scalar values the pin/enrich flow contends over, plus a (placeholder) email facet so
 * the enrich subject is realistic. job_title='Old Title' / department='Old Dept' start with EMPTY provenance
 * (the column default `{}`), so test 1's edit is the first thing to stamp a descriptor.
 */
async function seedContact(
  scope: { tenantId: string; workspaceId: string },
  ownerUserId: string,
): Promise<string> {
  const [c] = await admin`
    INSERT INTO contacts (
      tenant_id, workspace_id, owner_user_id,
      first_name, job_title, department,
      email_enc, email_blind_index, email_domain
    ) VALUES (
      ${scope.tenantId}, ${scope.workspaceId}, ${ownerUserId},
      ${"Jane"}, ${"Old Title"}, ${"Old Dept"},
      ${EMAIL_ENC}, ${EMAIL_BI}, ${"acme.com"}
    ) RETURNING id`;
  return (c as { id: string }).id;
}

/** Read the contended columns + their provenance descriptors back via the privileged admin connection. */
async function readContact(id: string): Promise<{
  job_title: string | null;
  department: string | null;
  field_provenance: Record<string, { src?: string; pin?: boolean; by?: string }>;
}> {
  const [row] = await admin`
    SELECT job_title, department, field_provenance FROM contacts WHERE id = ${id}`;
  return row as {
    job_title: string | null;
    department: string | null;
    field_provenance: Record<string, { src?: string; pin?: boolean; by?: string }>;
  };
}

beforeAll(async () => {
  dbHandle = await startItestDb("fieldProvenancePin");
  // env BEFORE the db singleton (and the config env singleton) loads.
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  // The enrich path checks the daily budget breaker against ENRICH_DAILY_BUDGET_MICROS before any paid call —
  // set it generously so the fake provider's (zero) spend never trips it.
  process.env.ENRICH_DAILY_BUDGET_MICROS = "1000000000";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA, ownerId: ownerA } = await seedTenantWorkspace("acme"));
  ({ tenantId: tenantB, workspaceId: wsB, ownerId: ownerB } = await seedTenantWorkspace("globex"));
  contactId = await seedContact({ tenantId: tenantA, workspaceId: wsA }, ownerA);
  contactB = await seedContact({ tenantId: tenantB, workspaceId: wsB }, ownerB);

  // env is set above, BEFORE either singleton loads.
  core = await import("../../core/src/index.ts");
  db = await import("@leadwolf/db");
  // The waterfall's circuit breakers are per-process state; start from a clean slate so the fake provider is
  // never pre-skipped by a leaked open breaker.
  core.resetBreakers();
}, 180_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

const scopeA = () => ({ tenantId: tenantA, workspaceId: wsA });
const scopeB = () => ({ tenantId: tenantB, workspaceId: wsB });

/**
 * A deterministic, INJECTED EnrichmentProvider (modelled on waterfall.test.ts's `fake`) that always HITS with
 * a fresh jobTitle + department. trust/cost are arbitrary (it is the only provider, so ordering is moot);
 * costMicros is 0 so it never contends with the budget breaker. Its name is `PROVIDER_NAME` ("zoominfo") so
 * the recorded provenance src is `provider:zoominfo`.
 */
function fakeProvider(): EnrichmentProvider {
  return {
    name: PROVIDER_NAME,
    trust: 0.9,
    capabilities: ["contact.profile"],
    estimateCostMicros: () => 0,
    enrich: () =>
      Promise.resolve({
        fields: [
          { field: "jobTitle", value: "Provider Title" },
          { field: "department", value: "Provider Dept" },
        ],
        rawPayload: { from: PROVIDER_NAME },
        costMicros: 0,
        status: "hit",
      }),
  };
}

describe("overlay field-provenance pin (PLAN_03 §1.4 — a human correction is sacrosanct)", () => {
  // ── TEST 1: THE PIN SETTER ──────────────────────────────────────────────────────────────────────────────
  // editContactFields applies a user hand-edit and PINS every edited scalar: the value is written and its
  // descriptor becomes {src:'user_edit', pin:true, by:<userId>}. This is what blocks the later enrichment.
  test("editContactFields writes the corrected value and pins it (src=user_edit, pin=true)", async () => {
    await core.editContactFields(scopeA(), contactId, { jobTitle: "Corrected Title" }, ownerA);

    const row = await readContact(contactId);
    expect(row.job_title).toBe("Corrected Title");
    const desc = row.field_provenance.jobTitle;
    expect(desc).toBeTruthy();
    expect(desc.pin).toBe(true);
    expect(desc.src).toBe("user_edit");
    expect(desc.by).toBe(ownerA);
    // The unedited scalar was untouched — its provenance is still absent (empty map start).
    expect(row.field_provenance.department).toBeUndefined();
    expect(row.department).toBe("Old Dept");
  });

  // ── TEST 2: ENRICHMENT RESPECTS THE PIN (THE CENTRAL PROOF) ──────────────────────────────────────────────
  // A provider returns BOTH jobTitle ('Provider Title') and department ('Provider Dept'). The PINNED jobTitle
  // must be left exactly as the user set it — value AND descriptor untouched — while the UNPINNED department IS
  // overwritten and gains a fresh `provider:` descriptor (pin:false). This is the F1 overlay-merge invariant.
  test("enrichContact skips the pinned field but overwrites the unpinned one", async () => {
    const result = await core.enrichContact({
      scope: scopeA(),
      contactId,
      fields: ["jobTitle", "department"],
      providers: [fakeProvider()],
      requestedByUserId: ownerA,
    });
    // The provider hit (sanity: the waterfall ran and the fake provider answered).
    expect(result.status).toBe("enriched");
    expect(result.provider).toBe(PROVIDER_NAME);

    const row = await readContact(contactId);

    // (a) The PINNED field survives — the provider's 'Provider Title' did NOT overwrite the user's correction,
    //     and the user_edit pin descriptor is intact (the provider write neither wrote the value nor the desc).
    expect(row.job_title).toBe("Corrected Title");
    const titleDesc = row.field_provenance.jobTitle;
    expect(titleDesc.pin).toBe(true);
    expect(titleDesc.src).toBe("user_edit");
    expect(titleDesc.by).toBe(ownerA);

    // (b) The UNPINNED field WAS overwritten by the provider, and its provenance now records the provider write
    //     (src starts with 'provider:', pin:false — a non-pinned, source-attributed overlay value).
    expect(row.department).toBe("Provider Dept");
    const deptDesc = row.field_provenance.department;
    expect(deptDesc).toBeTruthy();
    expect(deptDesc.src?.startsWith("provider:")).toBe(true);
    expect(deptDesc.src).toBe(`provider:${PROVIDER_NAME}`);
    expect(deptDesc.pin).toBe(false);
  });

  // ── TEST 3: THE PIN/EDIT PATH IS WORKSPACE-ISOLATED (RLS) ────────────────────────────────────────────────
  // editContactFields runs in a withTenantTx scoped to the CALLER's workspace, so a workspace-A edit aimed at a
  // workspace-B contact id touches NO row (the foreign id is invisible under RLS; getFieldProvenance reads `{}`
  // and the UPDATE matches nothing). The B contact keeps its seeded value and empty provenance.
  test("editContactFields under workspace A never touches a workspace-B contact (RLS)", async () => {
    await core.editContactFields(scopeA(), contactB, { jobTitle: "Cross-Tenant Poison" }, ownerA);

    const row = await readContact(contactB);
    expect(row.job_title).toBe("Old Title"); // unchanged — the A-scoped write never saw the B row
    expect(row.field_provenance.jobTitle).toBeUndefined(); // no descriptor stamped on the B contact

    // And the legitimate owner CAN edit it under workspace B (the row is real, just isolated from A).
    await core.editContactFields(scopeB(), contactB, { jobTitle: "B Owner Title" }, ownerB);
    const after = await readContact(contactB);
    expect(after.job_title).toBe("B Owner Title");
    expect(after.field_provenance.jobTitle?.pin).toBe(true);
    expect(after.field_provenance.jobTitle?.by).toBe(ownerB);
  });
});
