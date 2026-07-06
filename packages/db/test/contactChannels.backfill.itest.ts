// contactChannels.backfill.itest.ts — S-CH3's test gate (import-and-data-model-redesign 05 §Testing
// "backfill idempotency", 15 §T-P3 / §R-P3's wedge drill): the channel backfill against a real Postgres 16
// (Testcontainers by default, or ITEST_DATABASE_URL — see itestDb.ts). Run in its OWN process:
// `bun test ./packages/db/test/contactChannels.backfill.itest.ts`
//
// What is proven, per 15 §2.1:
//   1. Flat-only contacts (seeded through the REAL shipped import path with the tenant flag off) get their
//      `is_primary` child projection: email ciphertext + blind index BYTE-EQUAL to flat (asserted IN SQL —
//      never decrypted); phone value_enc byte-equal to flat with E.164 derived in-worker (hint from
//      locationCountry); the unparseable phone kept raw with NULL e164 material, flagged, never skipped.
//   2. Keyset batching + resume: a bounded first pass (batchSize 2, one batch) makes partial progress; the
//      next pass converges — the WHERE-missing selection IS the watermark (no stored cursor).
//   3. Idempotency: re-run after convergence ⇒ byte-identical child-table state, zero new rows (twice = once).
//   4. Dual-write-then-backfill collision safety: a workspace whose rows were projected by S-CH2 is not even
//      censused; a later legacy flat write re-opens ONLY its own channel — existing child rows untouched.
//   5. Fail-closed gate: tenant flag off ⇒ gateOff, zero writes (tenant selection + the batch-boundary abort).
//   6. Per-contact atomicity (the §R-P3 wedge drill): an injected DB failure mid-batch (trigger bomb on
//      contact_phones) rolls back the WHOLE batch — the failing contact's email row is absent too, never
//      half a contact; dropping the bomb and re-running converges.
//   7. THE S-CH4 GATE: countContactsMissingChannelProjection() reads 0 once every workspace drained.
//
// Env posture mirrors contactChannels.dualwrite.itest.ts: CHANNEL_DUAL_WRITE="true" for the whole process
// (frozen config); the per-tenant `channels_dual_write` flag drives on/off arms. Core is imported via the
// RELATIVE barrel (../../core/src/index.ts) — a @leadwolf/core dep here is a Turbo build cycle.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Core = typeof import("../../core/src/index.ts");
type Db = typeof import("@leadwolf/db");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let core: Core;
let db: Db;

// A = flat-first (seeded flag-off, then flag on — the mainline backfill arc)
// B = dual-first (flag on from birth — collision safety)
// C = gated (flag off — fail-closed; drained at the end for the completeness gate)
// D = atomicity (flat-first; the trigger-bomb wedge drill)
let tA = "";
let wsA = "";
let tB = "";
let wsB = "";
let tC = "";
let wsC = "";
let tD = "";
let wsD = "";

const MAPPING = {
  email: "Email",
  firstName: "First Name",
  phone: "Phone",
  locationCountry: "Country",
};

// Jane: email + national-format phone + ISO-2 hint (E.164 derivable). John: email only.
// Uma: email + short national phone + FREE-TEXT country ⇒ no hint guessed ⇒ unparseable, kept raw.
const rowsFor = (slug: string) => [
  {
    Email: `jane@${slug}.com`,
    "First Name": "Jane",
    Phone: "(415) 555-2671",
    Country: "US",
  },
  { Email: `john@${slug}.com`, "First Name": "John", Phone: "", Country: "" },
  {
    Email: `uma@${slug}.com`,
    "First Name": "Uma",
    Phone: "555 0100",
    Country: "United States",
  },
];

async function seedTenantWorkspace(
  slug: string,
): Promise<{ tenantId: string; workspaceId: string; ownerId: string }> {
  const [t] = await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const tenantId = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  const ownerId = (u as { id: string }).id;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tenantId}, ${ownerId}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, ${slug}, ${slug}, true, ${ownerId}) RETURNING id`;
  return { tenantId, workspaceId: (w as { id: string }).id, ownerId };
}

async function importFlat(scope: { tenantId: string; workspaceId: string }, ownerId: string, slug: string) {
  const res = await core.runImport({
    scope,
    importedByUserId: ownerId,
    sourceName: "manual",
    mapping: MAPPING,
    conflictPolicy: "overwrite",
    rows: rowsFor(slug),
  });
  expect(res.created).toBe(3);
}

async function enableFlag(tenantId: string) {
  await admin`
    INSERT INTO tenant_feature_flags (flag_key, tenant_id, enabled)
    VALUES ('channels_dual_write', ${tenantId}, true)`;
}

async function childCounts(workspaceId: string): Promise<{ emails: number; phones: number }> {
  const [e] = await admin`
    SELECT count(*)::int AS n FROM contact_emails WHERE workspace_id = ${workspaceId}`;
  const [p] = await admin`
    SELECT count(*)::int AS n FROM contact_phones WHERE workspace_id = ${workspaceId}`;
  return { emails: (e as { n: number }).n, phones: (p as { n: number }).n };
}

/** Deterministic full-state snapshot of both child tables for a workspace — the idempotency comparator. */
async function childState(workspaceId: string): Promise<unknown[]> {
  const emails = await admin`
    SELECT id, contact_id, encode(value_enc,'hex') AS v, encode(blind_index,'hex') AS bi, email_domain,
           type, is_primary, status, source, pinned, first_seen_at, updated_at
    FROM contact_emails WHERE workspace_id = ${workspaceId} ORDER BY id`;
  const phones = await admin`
    SELECT id, contact_id, encode(value_enc,'hex') AS v, encode(blind_index,'hex') AS bi,
           encode(e164_enc,'hex') AS e164, encode(e164_blind_index,'hex') AS e164bi, country_hint,
           line_type, line_type_source, type, is_primary, status, source, pinned, first_seen_at, updated_at
    FROM contact_phones WHERE workspace_id = ${workspaceId} ORDER BY id`;
  return [[...emails], [...phones]];
}

/** CH-INV-1's checkable form for the backfilled rows, asserted IN SQL (ciphertext never decrypted here). */
async function assertEmailProjectionByteEqual(workspaceId: string, expected: number) {
  const [m] = await admin`
    SELECT count(*)::int AS n FROM contacts c
    JOIN contact_emails ce ON ce.contact_id = c.id AND ce.is_primary AND ce.deleted_at IS NULL
    WHERE c.workspace_id = ${workspaceId}
      AND ce.value_enc = c.email_enc AND ce.blind_index = c.email_blind_index
      AND ce.email_domain = c.email_domain AND ce.status = c.email_status`;
  expect((m as { n: number }).n).toBe(expected);
  const [bad] = await admin`
    SELECT count(*)::int AS n FROM contacts c
    JOIN contact_emails ce ON ce.contact_id = c.id AND ce.is_primary AND ce.deleted_at IS NULL
    WHERE c.workspace_id = ${workspaceId}
      AND (ce.value_enc <> c.email_enc OR ce.blind_index <> c.email_blind_index)`;
  expect((bad as { n: number }).n).toBe(0);
}

const scope = (tenantId: string, workspaceId: string) => ({ tenantId, workspaceId });

beforeAll(async () => {
  dbHandle = await startItestDb("contact_channels_backfill");
  // env BEFORE the config/db singletons load (frozen config). CHANNEL_DUAL_WRITE arms the ENV half for the
  // whole process; the per-tenant flag half drives the arms. CHANNEL_BACKFILL_ENABLED is a register.ts
  // scheduling gate only — the runner is exercised directly here.
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";
  process.env.CHANNEL_DUAL_WRITE = "true";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  core = await import("../../core/src/index.ts");
  db = await import("@leadwolf/db");
  ({ tenantId: tA, workspaceId: wsA } = await seedTenantWorkspaceAndFlat("bfa"));
  ({ tenantId: tC, workspaceId: wsC } = await seedTenantWorkspaceAndFlat("bfc"));
  ({ tenantId: tD, workspaceId: wsD } = await seedTenantWorkspaceAndFlat("bfd"));
  // B is dual-first: flag ON BEFORE its import, so S-CH2 projects its child rows at write time.
  const b = await seedTenantWorkspace("bfb");
  tB = b.tenantId;
  wsB = b.workspaceId;
  await enableFlag(tB);
  await importFlat(scope(tB, wsB), b.ownerId, "bfb");
  // A and D backfill; C stays gated until the final test.
  await enableFlag(tA);
  await enableFlag(tD);
}, 180_000);

/** Seed tenant+workspace and import the three contacts FLAT-ONLY (flag off at import time). */
async function seedTenantWorkspaceAndFlat(
  slug: string,
): Promise<{ tenantId: string; workspaceId: string }> {
  const seeded = await seedTenantWorkspace(slug);
  await importFlat(scope(seeded.tenantId, seeded.workspaceId), seeded.ownerId, slug);
  const counts = await childCounts(seeded.workspaceId);
  expect(counts).toEqual({ emails: 0, phones: 0 }); // flat-only by construction (flag off)
  return seeded;
}

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("S-CH3 backfill — flat-only workspace converges to a byte-exact child projection", () => {
  test("bounded first pass makes partial progress; the WHERE-missing walk resumes and drains (watermark = selection)", async () => {
    // One batch of two contacts (Jane, John by uuid-v7 insert order) — the whale-wedge bound in miniature.
    const first = await core.runChannelBackfillForWorkspace(scope(tA, wsA), {
      batchSize: 2,
      maxBatches: 1,
    });
    expect(first.gateOff).toBe(false);
    expect(first.scanned).toBe(2);
    expect(first.emailsCreated).toBe(2);
    expect(first.phonesCreated).toBe(1); // Jane; John has no phone
    expect(first.drained).toBe(false);

    // Resume — a fresh call re-selects ONLY the still-missing tail (Uma), no stored cursor anywhere.
    const second = await core.runChannelBackfillForWorkspace(scope(tA, wsA));
    expect(second.scanned).toBe(1);
    expect(second.emailsCreated).toBe(1);
    expect(second.phonesCreated).toBe(1);
    expect(second.phonesUnparseable).toBe(1); // Uma — kept raw, flagged, never skipped
    expect(second.drained).toBe(true);

    const counts = await childCounts(wsA);
    expect(counts).toEqual({ emails: 3, phones: 2 });
  });

  test("email child rows are BYTE-EQUAL to flat (ciphertext + blind index — asserted in SQL, never decrypted)", async () => {
    await assertEmailProjectionByteEqual(wsA, 3);
    const meta = await admin`
      SELECT source, type, is_primary, pinned, source_import_id FROM contact_emails
      WHERE workspace_id = ${wsA}`;
    for (const r of meta as unknown as Array<Record<string, unknown>>) {
      expect(r.source).toBe("backfill");
      expect(r.type).toBe("other");
      expect(r.is_primary).toBe(true);
      expect(r.pinned).toBe(false);
      expect(r.source_import_id).toBeNull();
    }
  });

  test("phone child rows: value_enc flat-verbatim; E.164 derived for the hinted number; unparseable kept raw with NULL e164", async () => {
    const rows = await admin`
      SELECT c.first_name, (cp.value_enc = c.phone_enc) AS byte_equal, cp.e164_enc IS NOT NULL AS parsed,
             cp.country_hint, cp.status IS NOT DISTINCT FROM c.phone_status AS status_mirrored,
             cp.is_primary, cp.source
      FROM contacts c JOIN contact_phones cp ON cp.contact_id = c.id
      WHERE c.workspace_id = ${wsA} ORDER BY c.first_name`;
    const byName = Object.fromEntries(
      (rows as unknown as Array<{ first_name: string } & Record<string, unknown>>).map((r) => [
        r.first_name,
        r,
      ]),
    );
    expect(byName.Jane?.byte_equal).toBe(true);
    expect(byName.Jane?.parsed).toBe(true);
    expect(byName.Jane?.country_hint).toBe("US");
    expect(byName.Uma?.byte_equal).toBe(true);
    expect(byName.Uma?.parsed).toBe(false); // unparseable — e164 material NULL, raw preserved
    expect(byName.Uma?.country_hint).toBeNull(); // free-text country is never guessed at
    for (const r of Object.values(byName)) {
      expect(r.status_mirrored).toBe(true);
      expect(r.is_primary).toBe(true);
      expect(r.source).toBe("backfill");
    }
  });

  test("idempotency: re-run after convergence = byte-identical state, zero new rows (twice = once)", async () => {
    const before = await childState(wsA);
    const rerun = await core.runChannelBackfillForWorkspace(scope(tA, wsA));
    expect(rerun.scanned).toBe(0);
    expect(rerun.emailsCreated).toBe(0);
    expect(rerun.phonesCreated).toBe(0);
    expect(rerun.drained).toBe(true);
    expect(await childState(wsA)).toEqual(before);
    // …and the census no longer returns the workspace.
    const census = await db.contactChannelRepository.listWorkspacesMissingChannelProjection(1000);
    expect(census.some((w) => w.workspaceId === wsA)).toBe(false);
  });
});

describe("S-CH3 × S-CH2 — dual-write-then-backfill collision safety (any order is safe)", () => {
  test("a workspace fully projected by dual-write is not censused; a forced pass writes nothing and changes nothing", async () => {
    const counts = await childCounts(wsB);
    expect(counts).toEqual({ emails: 3, phones: 2 }); // S-CH2 projected at import time
    const census = await db.contactChannelRepository.listWorkspacesMissingChannelProjection(1000);
    expect(census.some((w) => w.workspaceId === wsB)).toBe(false);

    const before = await childState(wsB);
    const res = await core.runChannelBackfillForWorkspace(scope(tB, wsB));
    expect(res.scanned).toBe(0);
    expect(await childState(wsB)).toEqual(before);
  });

  test("a legacy flat write re-opens ONLY its own channel — the existing S-CH2 email row is untouched", async () => {
    // Simulate a pre-dual-write legacy path: a flat phone appears with no child row (John-B had no phone).
    const phoneEnc = core.encryptPii("+1 (212) 555-0100");
    await admin`
      UPDATE contacts SET phone_enc = ${Buffer.from(phoneEnc)}
      WHERE workspace_id = ${wsB} AND first_name = 'John'`;
    const emailBefore = await admin`
      SELECT id, updated_at, encode(value_enc,'hex') AS v FROM contact_emails ce
      JOIN contacts c ON c.id = ce.contact_id
      WHERE c.workspace_id = ${wsB} AND c.first_name = 'John'`;

    const res = await core.runChannelBackfillForWorkspace(scope(tB, wsB));
    expect(res.scanned).toBe(1); // John only — WHERE-missing is per channel, per contact
    expect(res.emailsCreated).toBe(0); // his email child already exists (S-CH2's) — NEVER touched
    expect(res.phonesCreated).toBe(1);

    const emailAfter = await admin`
      SELECT id, updated_at, encode(value_enc,'hex') AS v FROM contact_emails ce
      JOIN contacts c ON c.id = ce.contact_id
      WHERE c.workspace_id = ${wsB} AND c.first_name = 'John'`;
    expect([...emailAfter]).toEqual([...emailBefore]);
    const [phone] = await admin`
      SELECT (cp.value_enc = c.phone_enc) AS byte_equal, cp.e164_enc IS NOT NULL AS parsed, cp.source
      FROM contacts c JOIN contact_phones cp ON cp.contact_id = c.id
      WHERE c.workspace_id = ${wsB} AND c.first_name = 'John'`;
    expect((phone as { byte_equal: boolean }).byte_equal).toBe(true);
    expect((phone as { parsed: boolean }).parsed).toBe(true); // +-prefixed ⇒ parses with no hint
    expect((phone as { source: string }).source).toBe("backfill");
  });
});

describe("S-CH3 gate — fail-closed tenant selection IS the batch-boundary abort", () => {
  test("tenant flag off ⇒ gateOff, zero batches, zero writes", async () => {
    const res = await core.runChannelBackfillForWorkspace(scope(tC, wsC));
    expect(res.gateOff).toBe(true);
    expect(res.batches).toBe(0);
    expect(res.scanned).toBe(0);
    expect(await childCounts(wsC)).toEqual({ emails: 0, phones: 0 });
  });
});

describe("S-CH3 atomicity — the §R-P3 backfill wedge drill (injected mid-batch failure)", () => {
  test("a phone-insert bomb aborts the WHOLE batch: the failing contact's email row is absent too — never half a contact", async () => {
    await admin.unsafe(`
      CREATE FUNCTION itest_phone_bomb() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'itest injected mid-batch failure'; END
      $$ LANGUAGE plpgsql`);
    await admin.unsafe(`
      CREATE TRIGGER itest_phone_bomb BEFORE INSERT ON contact_phones
      FOR EACH ROW WHEN (NEW.workspace_id = '${wsD}') EXECUTE FUNCTION itest_phone_bomb()`);
    try {
      // Jane-D's email insert lands first in the batch tx; her phone insert then bombs ⇒ full rollback.
      await expect(core.runChannelBackfillForWorkspace(scope(tD, wsD))).rejects.toThrow(
        /itest injected/,
      );
      expect(await childCounts(wsD)).toEqual({ emails: 0, phones: 0 });
    } finally {
      await admin.unsafe("DROP TRIGGER itest_phone_bomb ON contact_phones");
      await admin.unsafe("DROP FUNCTION itest_phone_bomb()");
    }
  });

  test("after the wedge clears, a re-run converges (interrupt + rerun = identical end state)", async () => {
    const res = await core.runChannelBackfillForWorkspace(scope(tD, wsD));
    expect(res.emailsCreated).toBe(3);
    expect(res.phonesCreated).toBe(2);
    expect(res.drained).toBe(true);
    await assertEmailProjectionByteEqual(wsD, 3);
  });
});

describe("THE S-CH4 GATE — completeness reaches 0", () => {
  test("after every workspace drains (C's flag enabled last), countContactsMissingChannelProjection() = 0", async () => {
    expect(await db.contactChannelRepository.countContactsMissingChannelProjection()).toBeGreaterThan(
      0, // C is still flat-only
    );
    await enableFlag(tC);
    const res = await core.runChannelBackfillForWorkspace(scope(tC, wsC));
    expect(res.gateOff).toBe(false);
    expect(res.drained).toBe(true);
    expect(await db.contactChannelRepository.countContactsMissingChannelProjection()).toBe(0);
    expect(await db.contactChannelRepository.listWorkspacesMissingChannelProjection(1000)).toEqual(
      [],
    );
  });
});
