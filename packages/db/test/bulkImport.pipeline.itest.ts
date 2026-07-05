// bulkImport.pipeline.itest.ts — the end-to-end gate for the bulk COPY-staging import pipeline (data-management
// backlog #2; 15-bulk-import-design §1/§2/§8) on a real Postgres 16 (Testcontainers by default, or
// ITEST_DATABASE_URL — see itestDb.ts). Run in its OWN process (the db client is a module singleton):
// `bun test ./packages/db/test/bulkImport.pipeline.itest.ts`.
//
// This file is DOUBLY load-bearing — it is the only place two unverified-in-sandbox guarantees are exercised
// against a real server:
//
//   1. THE COPY-FROM-STDIN SPIKE (importStagingRepository header §6.4): copyRows streams CSV through
//      postgres.js `.writable()` into a per-job UNLOGGED, NON-RLS staging table, and readChunkBand reads it
//      back. Case 1 proves the §8 encoding round-trips BYTE-FOR-BYTE: bytea as unquoted `\x<hex>` → Buffer,
//      NULL as the unquoted empty field, jsonb/text quoted (internal quotes doubled, backslash literal in CSV
//      mode). If copyRows throws or a byte differs, that test failing IS the spike result.
//
//   2. THE BULK-vs-SYNC MERGE PARITY PROOF (bulkProcessChunk header): the batched chunk merge must land
//      BYTE-IDENTICAL results to the synchronous per-row runImport. Case 4 runs BOTH paths on the SAME bytes
//      into two workspaces with the SAME baseline and asserts the landed contact set (identities + scalar
//      values) is identical, plus the created/duplicate counts agree.
//
// Cases: (1) COPY round-trip; (2) within-file dedup keeps the lowest source_row_num; (3) full
// DRIVE→CHUNK→FINALIZE through a temp CSV + diskFileStore (pre-existing match under `skip`, an in-file dup, and
// new rows); (4) sync/bulk parity. The staging table is non-RLS (owner connection) per §1; the control plane
// is RLS-scoped (withTenantTx) like the other data-management itests. NO pipeline code is modified — this
// composes the real entry points (runBulkImport / bulkProcessChunk / finalizeIfLastChunk / runImport) only.
//
// ── S-P1 / GATE A (G09) — cases 5–7 (import-and-data-model-redesign 12 §3.2 criteria 2–4; 15 §M-SEQ seq 39;
// TP-1). Criterion 1 (functional round-trip: backpressure-aware Writable, byte-for-byte CSV encoding, bytea →
// Buffer) IS case 1 above — not duplicated. The shipped driver is postgres.js 3.4.5 and the spike runs through
// the REAL seam (`importStagingRepository.copyRows` → `ownerClient.unsafe(<COPY … FROM STDIN>).writable()`);
// if that API is absent or broken, case 5/6/7 fail loudly — a failing case IS the red verdict, and the red
// path is 12 §3.3's batched-INSERT fallback behind the same seam (never a redesign — 14 R01). The verdict is
// recorded in the ADR-0036 addendum ("verdict: pending CI" until this file runs green/red in CI).
//   5 (criterion 2): throughput floor — ≥ SPIKE_MIN_ROWS_PER_SEC (default 20 000) prepared rows/s sustained
//     over ≥ SPIKE_THROUGHPUT_ROWS (default 100 000) synthetic rows, after a small warmup band (the
//     CI-variance guard: a cold pool/JIT never decides the gate). ~500 B/row per 12 §3.2.
//   6 (criterion 3): memory plateau — producer RSS delta ≤ SPIKE_MAX_RSS_DELTA_MB (default 128) while
//     staging SPIKE_MEMORY_ROWS (default 1 000 000) rows, AND the delta must not correlate with row count
//     (plateau assertion: second-half growth bounded, not just a peak check).
//   7 (criterion 4): mid-stream cancel — destroying the Writable mid-COPY (producer throws → stream.pipeline
//     destroys the sink) rejects copyRows, leaves NO partial rows (COPY is atomic ⇒ a re-drive re-stages the
//     aborted band exactly once — the 15 §2 no-double-staging property AT THIS SEAM; the byte-watermark
//     resume above it is runBulkImport's and is exercised in case 3's machinery), leaves the owner
//     connection serviceable (no wedge), leaves no server-side COPY backend behind (pg_stat_activity), and
//     the staging table stays droppable.
// The G09 verdict is only valid at the DEFAULT parameters — the SPIKE_* env knobs exist for local smoke
// runs on weak machines, and CI must not lower them.
//
// PII identity WITHOUT plaintext: contacts are compared by their email_blind_index (HMAC bytea, hex-keyed) +
// email_domain + the cleartext scalar facets (names/title) — never a decrypted email. The conflict policy
// exercised is `skip` (the safe default: a match is a held-back DUPLICATE, the existing row untouched).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StagingRow } from "@leadwolf/db";
import type { ColumnMapping, ConflictPolicy, SourceName } from "@leadwolf/types";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

type Db = typeof import("@leadwolf/db");
type Core = typeof import("../../core/src/index.ts");
type PrepareMod = typeof import("../../core/src/import/prepareContact.ts");
type ContentHashMod = typeof import("../../core/src/import/contentHash.ts");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let db: Db;
let core: Core;
// prepareContact + contentHash are NOT on the core barrel (internals). They are reached by a relative SOURCE
// path (NOT the package name) — the same trick the other core-driven itests use to avoid a packages/db →
// @leadwolf/core devDep (the Turbo ^build cycle). Both are pure (DB-free); they need only env.BLIND_INDEX_KEY,
// set in beforeAll before the dynamic import, so case 1/2 can stage the REAL prepared output bulkStage produces.
let prepareContact: PrepareMod["prepareContact"];
let contentHash: ContentHashMod["contentHash"];

let tenantA = "";
let wsA = "";
let tenantB = "";
let wsB = "";
let tmpDir = "";

// Set in case 3, read in case 4 (the parity comparison reads workspace A's landed rows back from the DB).
let jobIdA = "";
let preexistingIdA = "";

// A VALID source_name enum value (the source_imports CHECK), NOT a filename — bulkProcessChunk stamps it.
const SOURCE_NAME: SourceName = "apollo";
// The conflict policy under test: a match against an existing contact is a held-back DUPLICATE (untouched).
const SKIP: ConflictPolicy = "skip";

// ── Case 3/4 fixtures: ONE CSV, two paths ───────────────────────────────────────────────────────────────────
// row0 (A) matches a pre-existing contact (→ duplicate under skip); row1 (B) + row2 (C) are new; row3 (D) is a
// BYTE-IDENTICAL in-file duplicate of B. Bulk collapses D at the staging dedup step (rows_deduped); sync skips D
// via its content-hash idempotency (skipped) — different counters, IDENTICAL landed set (the parity point).
const MAPPING: ColumnMapping = {
  firstName: "First Name",
  lastName: "Last Name",
  email: "Email",
  jobTitle: "Title",
  accountName: "Company",
  accountDomain: "Domain",
};
const HEADER = "First Name,Last Name,Email,Title,Company,Domain";
const ROW_A = "Ada,Lovelace,ada@acme-corp.test,Engineer,Acme Corp,acme-corp.test";
const ROW_B = "Grace,Hopper,grace@globex-co.test,Admiral,Globex,globex-co.test";
const ROW_C = "Alan,Turing,alan@enigma-co.test,Cryptanalyst,Enigma,enigma-co.test";
// ROW_B appears twice → the in-file duplicate the pipelines must collapse to one contact.
const CSV = `${[HEADER, ROW_A, ROW_B, ROW_C, ROW_B].join("\n")}\n`;
// The pre-existing contact, seeded IDENTICALLY into both workspaces (the shared baseline). Its mapped values
// equal ROW_A's landing values (account is excluded — it lives on `accounts`, not the contact row).
const MAPPED_PREEXISTING = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@acme-corp.test",
  jobTitle: "Engineer",
};

const scopeA = () => ({ tenantId: tenantA, workspaceId: wsA });
const scopeB = () => ({ tenantId: tenantB, workspaceId: wsB });

async function seedWorkspace(slug: string): Promise<{ tenantId: string; workspaceId: string }> {
  const [t] = await admin`
    INSERT INTO tenants (name, slug, reveal_credit_balance) VALUES (${slug}, ${slug}, 10) RETURNING id`;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${t!.id}, ${u!.id}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${t!.id}, ${slug}, ${slug}, true, ${u!.id}) RETURNING id`;
  return { tenantId: t!.id, workspaceId: w!.id };
}

/** bytea equality (postgres.js decodes bytea → Buffer): both null is equal; otherwise byte-for-byte. */
function bytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

/** Yield an array as an AsyncIterable (the shape copyRows pulls its rows from). */
async function* asAsync<T>(items: T[]): AsyncIterable<T> {
  for (const it of items) yield it;
}

/** Build a staging row from the REAL prepareContact output (the same assembly bulkStage.toStagingRow does), so
 *  the COPY round-trip exercises realistic ciphertext / blind-index / content-hash bytea, not synthetic bytes. */
function makeStagingRow(
  sourceRowNum: number,
  workspaceId: string,
  mapped: Parameters<typeof prepareContact>[0],
  rawData: Record<string, unknown>,
): StagingRow {
  const prepared = prepareContact(mapped);
  const v = prepared.values;
  const identityKey = v.emailBlindIndex
    ? Buffer.from(v.emailBlindIndex).toString("hex")
    : prepared.dedupKeys.linkedinPublicId
      ? `li:${prepared.dedupKeys.linkedinPublicId}`
      : prepared.dedupKeys.salesNavLeadId
        ? `sn:${prepared.dedupKeys.salesNavLeadId}`
        : null;
  return {
    sourceRowNum,
    workspaceId,
    identityKey,
    emailEnc: v.emailEnc ?? null,
    phoneEnc: v.phoneEnc ?? null,
    emailBlindIndex: v.emailBlindIndex ?? null,
    contentHash: contentHash({ mapped, sourceName: SOURCE_NAME }),
    emailDomain: v.emailDomain ?? null,
    linkedinPublicId: v.linkedinPublicId ?? null,
    salesNavLeadId: v.salesNavLeadId ?? null,
    firstName: v.firstName ?? null,
    lastName: v.lastName ?? null,
    jobTitle: v.jobTitle ?? null,
    seniorityLevel: v.seniorityLevel ?? null,
    department: v.department ?? null,
    linkedinUrl: v.linkedinUrl ?? null,
    salesNavProfileUrl: v.salesNavProfileUrl ?? null,
    locationCountry: v.locationCountry ?? null,
    locationCity: v.locationCity ?? null,
    accountName: prepared.accountName ?? null,
    accountDomain: prepared.accountDomain ?? null,
    rawData,
  };
}

/** Assert every field of a read-back staging row matches what was COPY-loaded — the SPIKE's core assertion. */
function expectStagingRowEqual(got: StagingRow, want: StagingRow): void {
  expect(got.sourceRowNum).toBe(want.sourceRowNum);
  expect(got.workspaceId).toBe(want.workspaceId);
  expect(got.identityKey).toBe(want.identityKey);
  // bytea: come back as Buffers, byte-for-byte; NULL stays null.
  expect(bytesEqual(got.emailEnc, want.emailEnc)).toBe(true);
  expect(bytesEqual(got.phoneEnc, want.phoneEnc)).toBe(true);
  expect(bytesEqual(got.emailBlindIndex, want.emailBlindIndex)).toBe(true);
  expect(bytesEqual(got.contentHash, want.contentHash)).toBe(true);
  // scalar text (incl. embedded commas / quotes / unicode) round-trips intact.
  expect(got.emailDomain).toBe(want.emailDomain);
  expect(got.linkedinPublicId).toBe(want.linkedinPublicId);
  expect(got.salesNavLeadId).toBe(want.salesNavLeadId);
  expect(got.firstName).toBe(want.firstName);
  expect(got.lastName).toBe(want.lastName);
  expect(got.jobTitle).toBe(want.jobTitle);
  expect(got.seniorityLevel).toBe(want.seniorityLevel);
  expect(got.department).toBe(want.department);
  expect(got.linkedinUrl).toBe(want.linkedinUrl);
  expect(got.salesNavProfileUrl).toBe(want.salesNavProfileUrl);
  expect(got.locationCountry).toBe(want.locationCountry);
  expect(got.locationCity).toBe(want.locationCity);
  expect(got.accountName).toBe(want.accountName);
  expect(got.accountDomain).toBe(want.accountDomain);
  // jsonb deep-equals (the only plaintext in staging — dropped on finalize).
  expect(got.rawData).toEqual(want.rawData);
}

/** Seed the pre-existing contact directly (no source_import provenance), via the REAL prepareContact so its
 *  email_blind_index matches what ROW_A computes — making it the dedup target the import holds back. */
async function seedExisting(scope: { tenantId: string; workspaceId: string }): Promise<string> {
  return db.withTenantTx(scope, (tx) => {
    const prepared = prepareContact(MAPPED_PREEXISTING);
    return db.contactRepository.insert(tx, {
      ...prepared.values,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      accountId: null,
    });
  });
}

/** Count the LIVE (non-tombstoned) contacts of a workspace on the owner connection. */
async function countLiveContacts(workspaceId: string): Promise<number> {
  const [r] = (await admin`
    SELECT count(*)::int AS n
      FROM contacts
     WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL`) as { n: number }[];
  return r!.n;
}

/** The landed contacts of a workspace, reduced to the PII-safe identity + scalar facets, sorted for comparison.
 *  Read on the owner connection (BYPASSRLS) — the cross-path comparison is intentionally cross-workspace. */
async function landedContacts(workspaceId: string): Promise<Array<Record<string, unknown>>> {
  const rows = (await admin`
    SELECT email_blind_index, email_domain, first_name, last_name, job_title,
           seniority_level, department, location_country, location_city
      FROM contacts
     WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL`) as Array<Record<string, unknown>>;
  return rows
    .map((r) => ({
      blindHex: r.email_blind_index
        ? Buffer.from(r.email_blind_index as Uint8Array).toString("hex")
        : null,
      emailDomain: r.email_domain ?? null,
      firstName: r.first_name ?? null,
      lastName: r.last_name ?? null,
      jobTitle: r.job_title ?? null,
      seniorityLevel: r.seniority_level ?? null,
      department: r.department ?? null,
      locationCountry: r.location_country ?? null,
      locationCity: r.location_city ?? null,
    }))
    .sort((x, y) => String(x.blindHex).localeCompare(String(y.blindHex)));
}

beforeAll(async () => {
  dbHandle = await startItestDb("bulk-import-pipeline");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsA } = await seedWorkspace("acme"));
  ({ tenantId: tenantB, workspaceId: wsB } = await seedWorkspace("globex"));
  tmpDir = await mkdtemp(join(tmpdir(), "bulk-import-itest-"));

  // env is set ABOVE, before these dynamic imports load @leadwolf/config / the db singleton (and the core
  // pipeline, which imports @leadwolf/db transitively — same singleton). Core is reached via the source barrel,
  // and prepareContact/contentHash via their relative source paths, NOT the package name, to avoid the Turbo
  // devDep cycle (mirrors the other core-driven itests, e.g. import.itest.ts / retention.itest.ts).
  db = await import("@leadwolf/db");
  core = await import("../../core/src/index.ts");
  ({ prepareContact } = await import("../../core/src/import/prepareContact.ts"));
  ({ contentHash } = await import("../../core/src/import/contentHash.ts"));
}, 180_000);

afterAll(async () => {
  await db?.closeDb();
  await admin?.end();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  await dbHandle?.stop();
});

describe("bulk import pipeline: COPY spike + drive/chunk/finalize + sync parity", () => {
  // ── 1. THE COPY-FROM-STDIN SPIKE — byte-for-byte round-trip ───────────────────────────────────────────────
  test("1: copyRows → readChunkBand round-trips every field (bytea, NULL, jsonb, special-char text)", async () => {
    const jobId = randomUUID();
    await db.importStagingRepository.createStagingTable(jobId, wsA);
    try {
      // row0: full PII (email + phone + linkedin) and scalars with commas, quotes, apostrophes, unicode — the
      // CSV-quoting torture row. row1: linkedin-only (no email/phone) — the NULL-bytea round-trip. row2: email,
      // no phone. rawData carries embedded `"` and `,` so the jsonb-through-CSV encoding is exercised too.
      const rows: StagingRow[] = [
        makeStagingRow(
          0,
          wsA,
          {
            email: "alice@round.test",
            phone: "+1 555 0100",
            firstName: 'Alice "A." O\'Brien',
            lastName: "Zürich, Jr",
            jobTitle: "VP, Sales & Ops",
            department: "R&D",
            linkedinUrl: "https://linkedin.com/in/alice-x",
            locationCountry: "US",
            locationCity: "San José",
            accountName: "Round, Inc.",
            accountDomain: "round.test",
          },
          {
            "First Name": 'Alice "A." O\'Brien',
            Email: "alice@round.test",
            Note: 'comma,and "quote"',
          },
        ),
        makeStagingRow(
          1,
          wsA,
          { linkedinUrl: "https://linkedin.com/in/bob-y", firstName: "Bob", lastName: "Smith" },
          { Profile: "https://linkedin.com/in/bob-y", "First Name": "Bob" },
        ),
        makeStagingRow(
          2,
          wsA,
          { email: "carol@round.test", firstName: "Carol" },
          { Email: "carol@round.test", Unicode: "Zürich — café" },
        ),
      ];

      await db.importStagingRepository.copyRows(jobId, asAsync(rows));
      const got = await db.importStagingRepository.readChunkBand(jobId, wsA, 0, rows.length);

      expect(got).toHaveLength(3);
      // The bytea columns must decode to real Buffers (the spike's hard claim #3), not strings/hex text.
      expect(got[0]!.emailEnc).toBeInstanceOf(Uint8Array);
      expect(got[0]!.emailBlindIndex).toBeInstanceOf(Uint8Array);
      expect(got[0]!.phoneEnc).toBeInstanceOf(Uint8Array);
      expect(got[0]!.contentHash).toBeInstanceOf(Uint8Array);
      // NULL email/phone stays null (the linkedin-only row) — never a zero-length Buffer or "" .
      expect(got[1]!.emailEnc).toBeNull();
      expect(got[1]!.phoneEnc).toBeNull();
      expect(got[1]!.emailBlindIndex).toBeNull();
      expect(got[1]!.emailDomain).toBeNull();
      expect(got[2]!.phoneEnc).toBeNull();
      // Every field, byte-for-byte, against what was loaded.
      for (let i = 0; i < rows.length; i += 1) expectStagingRowEqual(got[i]!, rows[i]!);
    } finally {
      await db.importStagingRepository.dropStagingTable(jobId);
    }
  });

  // ── 2. WITHIN-FILE DEDUP — survivor is the lowest source_row_num ──────────────────────────────────────────
  test("2: dedupWithinFile marks the later same-identity row; readChunkBand returns only the survivor", async () => {
    const jobId = randomUUID();
    await db.importStagingRepository.createStagingTable(jobId, wsA);
    try {
      // rows 0 and 2 share an identity (same email → same blind index → same identity_key); row 1 is distinct.
      const dupEmail = "dana@dedup.test";
      const rows: StagingRow[] = [
        makeStagingRow(
          0,
          wsA,
          { email: dupEmail, firstName: "Dana", lastName: "First" },
          { n: "0" },
        ),
        makeStagingRow(1, wsA, { email: "evan@dedup.test", firstName: "Evan" }, { n: "1" }),
        makeStagingRow(
          2,
          wsA,
          { email: dupEmail, firstName: "Dana", lastName: "Later" },
          { n: "2" },
        ),
      ];
      // Sanity: 0 and 2 really do collide on identity_key; 1 does not.
      expect(rows[0]!.identityKey).toBe(rows[2]!.identityKey);
      expect(rows[0]!.identityKey).not.toBe(rows[1]!.identityKey);

      await db.importStagingRepository.copyRows(jobId, asAsync(rows));
      const marked = await db.importStagingRepository.dedupWithinFile(jobId);
      expect(marked).toBe(1); // exactly the later duplicate (row 2)

      const survivors = await db.importStagingRepository.readChunkBand(jobId, wsA, 0, rows.length);
      expect(survivors).toHaveLength(2);
      // The lowest source_row_num wins for the duplicated identity (row 2 was marked, row 0 survives).
      expect(survivors.map((r) => r.sourceRowNum)).toEqual([0, 1]);
      const danaSurvivor = survivors.find((r) => r.identityKey === rows[0]!.identityKey);
      expect(danaSurvivor?.sourceRowNum).toBe(0);
    } finally {
      await db.importStagingRepository.dropStagingTable(jobId);
    }
  });

  // ── 3. FULL DRIVE → CHUNK → FINALIZE via a temp CSV + diskFileStore ───────────────────────────────────────
  test("3: runBulkImport → bulkProcessChunk → finalizeIfLastChunk merges, counts, finalizes", async () => {
    const fileStore = core.diskFileStore(tmpDir);
    const sourceKey = "imports/case3/source.csv";
    await fileStore.putObject(sourceKey, Buffer.from(CSV, "utf8"));

    // A pre-existing contact ROW_A will match (→ duplicate under `skip`, untouched).
    preexistingIdA = await seedExisting(scopeA());

    const created = await db.withTenantTx(scopeA(), (tx) =>
      db.importJobRepository.createJob(tx, {
        tenantId: tenantA,
        workspaceId: wsA,
        sourceFile: sourceKey,
        sourceName: SOURCE_NAME,
        columnMapping: MAPPING,
        conflictPolicy: SKIP,
      }),
    );
    jobIdA = created.id;

    // DRIVE: stage (the real COPY load) + plan + fan out. The injected enqueue just collects the chunk ids.
    const collected: string[] = [];
    const driveResult = await core.runBulkImport({
      scope: scopeA(),
      jobId: jobIdA,
      fileStore,
      enqueueChunk: (_jobId, _scope, chunkId) => {
        collected.push(chunkId);
      },
    });
    expect(driveResult.status).toBe("staged");
    expect(driveResult.resumed).toBe(false);
    expect(driveResult.totalChunks).toBe(1);
    expect(driveResult.enqueuedChunks).toBe(1);
    expect(driveResult.stage?.total).toBe(4); // 4 parsed data rows
    expect(driveResult.stage?.rejected).toBe(0);
    expect(driveResult.stage?.dedupedInFile).toBe(1); // the in-file ROW_B duplicate
    expect(collected).toHaveLength(1);

    // CHUNK: merge each fanned-out chunk, then finalize (only on a real completion — processed === true).
    let finalize: Awaited<ReturnType<Core["finalizeIfLastChunk"]>> | undefined;
    for (const chunkId of collected) {
      const res = await core.bulkProcessChunk({ scope: scopeA(), jobId: jobIdA, chunkId });
      expect(res.processed).toBe(true);
      expect(res.created).toBe(2); // ROW_B + ROW_C
      expect(res.matched).toBe(0);
      expect(res.duplicate).toBe(1); // ROW_A held back under skip
      expect(res.processedRows).toBe(3); // 3 staging survivors (the in-file dup was excluded)
      finalize = await core.finalizeIfLastChunk({ scope: scopeA(), jobId: jobIdA });
    }
    expect(finalize?.finalized).toBe(true);
    expect(finalize?.fireRollups).toBe(true); // ≥1 contact landed

    // Control-row counters (atomic deltas onto the zeroed columns) + terminal status.
    const job = await db.withTenantTx(scopeA(), (tx) => db.importJobRepository.getJobSystem(tx, jobIdA));
    expect(job?.status).toBe("completed");
    expect(job?.rowsTotal).toBe(4);
    expect(job?.rowsCreated).toBe(2);
    expect(job?.rowsMatched).toBe(0);
    expect(job?.rowsDuplicate).toBe(1);
    expect(job?.rowsDeduped).toBe(1);
    expect(job?.rowsRejected).toBe(0);
    expect(job?.rowsSkipped).toBe(0);
    expect(job?.rowsUnprocessed).toBe(0);

    // The chunk is terminal.
    const chunks = await db.withTenantTx(scopeA(), (tx) =>
      db.importJobRepository.listChunks(tx, jobIdA),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks.every((c) => c.status === "completed")).toBe(true);
    expect(chunks[0]!.processedRows).toBe(3);

    // Contacts: the pre-existing one (untouched) + 2 created = 3 live; the in-file dup collapsed to one B.
    expect(await countLiveContacts(wsA)).toBe(3);

    // The per-row ledger: one row per processed staging survivor (the deduped row never reaches the chunk).
    const ledger = (await admin`
      SELECT row_index, outcome, created_contact_id, matched_contact_id
        FROM import_job_rows WHERE job_id = ${jobIdA} ORDER BY row_index`) as Array<{
      row_index: number;
      outcome: string;
      created_contact_id: string | null;
      matched_contact_id: string | null;
    }>;
    expect(ledger.map((r) => r.row_index)).toEqual([0, 1, 2]);
    expect(ledger.map((r) => r.outcome)).toEqual(["duplicate", "created", "created"]);
    // ROW_A matched the untouched pre-existing contact.
    expect(ledger[0]!.matched_contact_id).toBe(preexistingIdA);
    expect(ledger[1]!.created_contact_id).not.toBeNull();
    expect(ledger[2]!.created_contact_id).not.toBeNull();

    // Provenance: one source_imports row per LANDING row (created/matched) — duplicates append none.
    const [provCount] = (await admin`
      SELECT count(*)::int AS n
        FROM source_imports WHERE workspace_id = ${wsA}`) as { n: number }[];
    expect(provCount!.n).toBe(2);

    // Finalize dropped the per-job staging table (best-effort cleanup; the file remains the source of truth).
    const stagingName = db.importStagingRepository.stagingTableName(jobIdA);
    const [reg] = (await admin`SELECT to_regclass(${stagingName}) AS t`) as { t: string | null }[];
    expect(reg!.t).toBeNull();
  });

  // ── 4. PARITY — sync runImport lands the SAME result as the bulk merge ────────────────────────────────────
  test("4: sync runImport into workspace B lands an identical contact set + matching counts", async () => {
    // Same baseline as workspace A (case 3): the same pre-existing contact, seeded identically.
    await seedExisting(scopeB());

    // Drive the SYNC path over the SAME bytes (parsed by the sync parser) with the SAME source/policy.
    const parsed = core.parseCsv(CSV);
    expect(parsed.rows).toHaveLength(4);
    const summary = await core.runImport({
      scope: scopeB(),
      sourceName: SOURCE_NAME,
      mapping: MAPPING,
      rows: parsed.rows,
      conflictPolicy: SKIP,
    });
    expect(summary.total).toBe(4);
    expect(summary.created).toBe(2); // ROW_B + ROW_C
    expect(summary.matched).toBe(0);
    expect(summary.duplicates).toBe(1); // ROW_A held back under skip
    expect(summary.skipped).toBe(1); // the in-file ROW_B duplicate (content-hash idempotency)
    expect(summary.rejected).toBe(0);

    // workspace B has the same live count as A: pre-existing + 2 created.
    expect(await countLiveContacts(wsB)).toBe(3);

    // The bulk control-row counters (case 3) vs the sync summary: created + duplicate agree exactly. The
    // in-file duplicate lands in DIFFERENT buckets by design — bulk `deduped` (dropped at the staging dedup
    // step) vs sync `skipped` (content-hash idempotency) — but BOTH are 1 and BOTH collapse to one B contact.
    const jobA = await db.withTenantTx(scopeA(), (tx) => db.importJobRepository.getJobSystem(tx, jobIdA));
    expect(summary.created).toBe(jobA?.rowsCreated); // 2 === 2
    expect(summary.duplicates).toBe(jobA?.rowsDuplicate); // 1 === 1
    // skipped ↔ deduped: the documented divergence (1 === 1) — the in-file dup, different bucket, same effect.
    expect(summary.skipped).toBe(jobA?.rowsDeduped);

    // THE PARITY GUARANTEE: the landed contact SET is byte-identical across the two paths — same identities
    // (email_blind_index) and same scalar facets. PII identity is compared via the blind index + email_domain
    // + cleartext facets, never a decrypted email. (account_id / master bridges differ per workspace by
    // construction, so they are deliberately excluded from the comparison.)
    const a = await landedContacts(wsA);
    const b = await landedContacts(wsB);
    expect(a).toHaveLength(3);
    expect(b).toEqual(a);
    // And every identity is present on both sides (the explicit identity-set check).
    expect(new Set(b.map((r) => r.blindHex))).toEqual(new Set(a.map((r) => r.blindHex)));
  });
});

// ═══ S-P1 / GATE A (G09) — the COPY spike as CI assertions (12 §3.2 criteria 2–4; TP-1) ═══════════════════

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// The G09 verdict is valid ONLY at these defaults (12 §3.2's bars). Knobs exist for local smoke runs.
const SPIKE_THROUGHPUT_ROWS = intEnv("SPIKE_THROUGHPUT_ROWS", 100_000);
const SPIKE_MIN_ROWS_PER_SEC = intEnv("SPIKE_MIN_ROWS_PER_SEC", 20_000);
const SPIKE_MEMORY_ROWS = intEnv("SPIKE_MEMORY_ROWS", 1_000_000);
const SPIKE_MAX_RSS_DELTA_BYTES = intEnv("SPIKE_MAX_RSS_DELTA_MB", 128) * 1024 * 1024;
// Plateau bound: the RSS delta over the SECOND half of the stream may exceed the first-half max by at most
// this much — "the delta must not correlate with row count" (12 §3.2 criterion 3), with GC-noise headroom.
const SPIKE_MAX_PLATEAU_GROWTH_BYTES = 32 * 1024 * 1024;

// Prepared-row-shaped templates (~500 B/row per 12 §3.2: bytea ciphertext/blind-index/hash sizes mirror what
// prepareContact emits — AES-GCM ciphertext ~64 B, HMAC blind index 32 B, sha256 content hash 32 B). The
// buffers are SHARED across rows (the per-row cost is the CSV hex/quote encode — the real producer cost);
// identity_key varies per row so nothing in the table collapses. Generated IN-PROCESS — no fixtures on disk.
const SPIKE_EMAIL_ENC = Buffer.alloc(64, 0xa7);
const SPIKE_BLIND_INDEX = Buffer.alloc(32, 0x5c);
const SPIKE_CONTENT_HASH = Buffer.alloc(32, 0x33);

/** Synthetic prepared rows [startAt, startAt+count): cheap per-row (no crypto — rows arrive PREPARED at this
 *  seam), unique identity_key/source_row_num. `onRow` = RSS sampling hook; `abortAt` = mid-stream producer
 *  throw (stream.pipeline then destroys the COPY Writable — criterion 4's cancel). */
async function* syntheticRows(
  count: number,
  workspaceId: string,
  opts: { startAt?: number; onRow?: (i: number) => void; abortAt?: number } = {},
): AsyncIterable<StagingRow> {
  const startAt = opts.startAt ?? 0;
  for (let i = 0; i < count; i += 1) {
    if (opts.abortAt !== undefined && i === opts.abortAt) {
      throw new Error("SPIKE mid-stream cancel (deliberate)");
    }
    opts.onRow?.(i);
    const n = startAt + i;
    yield {
      sourceRowNum: n,
      workspaceId,
      identityKey: `spike:${n.toString(16).padStart(16, "0")}`,
      emailEnc: SPIKE_EMAIL_ENC,
      phoneEnc: null,
      emailBlindIndex: SPIKE_BLIND_INDEX,
      contentHash: SPIKE_CONTENT_HASH,
      emailDomain: "spike.test",
      linkedinPublicId: null,
      salesNavLeadId: null,
      firstName: "Synthetic",
      lastName: `Row ${n}`,
      jobTitle: "Load Generator, Sr.",
      seniorityLevel: null,
      department: "R&D",
      linkedinUrl: null,
      salesNavProfileUrl: null,
      locationCountry: "US",
      locationCity: "San José",
      accountName: "Spike, Inc.",
      accountDomain: "spike.test",
      rawData: { n },
    };
  }
}

/** Server-side COPY backends still alive for THIS database (excluding us). Criterion 4's no-leak probe. */
async function lingeringCopyBackends(): Promise<number> {
  const [r] = (await admin`
    SELECT count(*)::int AS n
      FROM pg_stat_activity
     WHERE datname = current_database()
       AND pid <> pg_backend_pid()
       AND state <> 'idle'
       AND query ILIKE 'COPY %'`) as { n: number }[];
  return r!.n;
}

/** Best-effort GC so RSS baselines/samples measure the producer, not pre-test garbage (Bun exposes gc()). */
function tryGc(): void {
  (globalThis as unknown as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc?.(true);
}

describe("S-P1 — the COPY spike (Gate A / G09): criteria 2–4 as CI assertions", () => {
  // ── 5. CRITERION 2 — throughput floor: ≥ 20k prepared rows/s sustained over ≥ 100k rows ─────────────────
  test(
    `5: copyRows sustains ≥ ${SPIKE_MIN_ROWS_PER_SEC} rows/s over ${SPIKE_THROUGHPUT_ROWS} synthetic rows`,
    async () => {
      const jobId = randomUUID();
      await db.importStagingRepository.createStagingTable(jobId, wsA);
      try {
        // Warmup band (NOT timed): pool checkout, prepared paths, JIT — the generous CI-variance guard.
        // The floor itself is NOT discounted: the timed run must clear the 12 §3.2 bar as-is.
        await db.importStagingRepository.copyRows(jobId, syntheticRows(5_000, wsA, { startAt: 0 }));

        const t0 = performance.now();
        await db.importStagingRepository.copyRows(
          jobId,
          syntheticRows(SPIKE_THROUGHPUT_ROWS, wsA, { startAt: 5_000 }),
        );
        const elapsedSec = (performance.now() - t0) / 1_000;
        const rowsPerSec = SPIKE_THROUGHPUT_ROWS / elapsedSec;

        // Integrity at volume first (a fast wrong answer is not a pass), then the floor.
        expect(await db.importStagingRepository.countStaged(jobId)).toBe(
          5_000 + SPIKE_THROUGHPUT_ROWS,
        );
        // The measured number MUST surface in the CI log — it is the figure the ADR-0036 addendum records.
        console.info(
          `[S-P1 criterion 2] ${SPIKE_THROUGHPUT_ROWS} rows in ${elapsedSec.toFixed(2)}s = ${Math.round(rowsPerSec)} rows/s (floor ${SPIKE_MIN_ROWS_PER_SEC})`,
        );
        expect(rowsPerSec).toBeGreaterThanOrEqual(SPIKE_MIN_ROWS_PER_SEC);
      } finally {
        await db.importStagingRepository.dropStagingTable(jobId);
      }
    },
    300_000,
  );

  // ── 6. CRITERION 3 — memory plateau: RSS delta ≤ 128 MB at ≥ 1M rows, and NOT row-count-correlated ──────
  test(
    `6: producer RSS delta stays ≤ ${Math.round(SPIKE_MAX_RSS_DELTA_BYTES / 1024 / 1024)} MB and plateaus while staging ${SPIKE_MEMORY_ROWS} rows`,
    async () => {
      const jobId = randomUUID();
      await db.importStagingRepository.createStagingTable(jobId, wsA);
      try {
        tryGc();
        const baseline = process.memoryUsage().rss;
        const samples: Array<{ atRow: number; rss: number }> = [];
        const SAMPLE_EVERY = 50_000;

        await db.importStagingRepository.copyRows(
          jobId,
          syntheticRows(SPIKE_MEMORY_ROWS, wsA, {
            onRow: (i) => {
              if (i > 0 && i % SAMPLE_EVERY === 0) {
                samples.push({ atRow: i, rss: process.memoryUsage().rss });
              }
            },
          }),
        );
        samples.push({ atRow: SPIKE_MEMORY_ROWS, rss: process.memoryUsage().rss });

        expect(await db.importStagingRepository.countStaged(jobId)).toBe(SPIKE_MEMORY_ROWS);

        const deltas = samples.map((s) => s.rss - baseline);
        const overallMax = Math.max(...deltas);
        const mid = Math.floor(samples.length / 2);
        const firstHalfMax = Math.max(...deltas.slice(0, Math.max(mid, 1)));
        // The measured number MUST surface in the CI log — it is the figure the ADR-0036 addendum records.
        console.info(
          `[S-P1 criterion 3] RSS delta max ${(overallMax / 1024 / 1024).toFixed(1)} MB over ${SPIKE_MEMORY_ROWS} rows; first-half max ${(firstHalfMax / 1024 / 1024).toFixed(1)} MB (${samples.length} samples)`,
        );
        // The ceiling: constant-memory property, absolute.
        expect(overallMax).toBeLessThanOrEqual(SPIKE_MAX_RSS_DELTA_BYTES);
        // The PLATEAU: doubling the rows streamed must not keep growing RSS — second-half growth over the
        // first-half max is bounded by GC-noise headroom, never proportional to row count.
        expect(overallMax - firstHalfMax).toBeLessThanOrEqual(SPIKE_MAX_PLATEAU_GROWTH_BYTES);
      } finally {
        await db.importStagingRepository.dropStagingTable(jobId);
      }
    },
    600_000,
  );

  // ── 7. CRITERION 4 — mid-stream cancel: abort, no wedge, no partial rows, no backend leak, droppable ────
  test(
    "7: destroying the COPY stream mid-flight aborts cleanly; re-drive stages exactly once; table droppable",
    async () => {
      const jobId = randomUUID();
      await db.importStagingRepository.createStagingTable(jobId, wsA);
      // NO try/finally around the drop here — the DROP is itself an assertion (a wedged/locked staging
      // table after an aborted COPY is exactly the failure mode criterion 4 exists to catch).
      const BASELINE = 1_000;
      const BAND = 50_000;

      // A committed baseline band, so atomicity is observable against a non-empty table.
      await db.importStagingRepository.copyRows(jobId, syntheticRows(BASELINE, wsA, { startAt: 0 }));
      expect(await db.importStagingRepository.countStaged(jobId)).toBe(BASELINE);

      // Mid-stream cancel: the producer throws at row 25 000 of the 50 000-row band → stream.pipeline
      // destroys the COPY Writable → the server-side COPY must abort. copyRows rejects (wrapped with the
      // jobId; the underlying reason may be the producer error or the driver's premature-close, either is
      // a correct abort — the load-bearing assertions are the post-conditions below).
      await expect(
        db.importStagingRepository.copyRows(
          jobId,
          syntheticRows(BAND, wsA, { startAt: BASELINE, abortAt: 25_000 }),
        ),
      ).rejects.toThrow(/copyRows failed/);

      // No wedge: the owner connection keeps serving queries…
      expect(await db.importStagingRepository.countStaged(jobId)).toBe(BASELINE);
      // …and COPY atomicity means the aborted band contributed ZERO rows — which is exactly why the
      // re-drive below can re-stage the whole band without double-staging (15 §2 at this seam).

      // No server-side leak: the aborted COPY backend must wind down (poll — the server needs a moment).
      let lingering = -1;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        lingering = await lingeringCopyBackends();
        if (lingering === 0) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(lingering).toBe(0);

      // Re-drive the SAME band to completion: lands exactly once (baseline + band, no dupes possible).
      await db.importStagingRepository.copyRows(jobId, syntheticRows(BAND, wsA, { startAt: BASELINE }));
      expect(await db.importStagingRepository.countStaged(jobId)).toBe(BASELINE + BAND);

      // And the staging table is droppable — no orphan lock from the aborted COPY.
      await db.importStagingRepository.dropStagingTable(jobId);
      const stagingName = db.importStagingRepository.stagingTableName(jobId);
      const [reg] = (await admin`SELECT to_regclass(${stagingName}) AS t`) as { t: string | null }[];
      expect(reg!.t).toBeNull();
    },
    120_000,
  );
});
