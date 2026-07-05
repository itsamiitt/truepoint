// importFast.parity.itest.ts — S-I3's test gate (import-and-data-model-redesign 15 §T-P1, seq 11): the
// T1 PARITY harness (the same parsed file through the legacy engine and the v2 fast dual-write wrapper
// lands the IDENTICAL contact end-state and the identical tally — the wrapper adds durable state, never
// behavior), T4 ACCOUNTING IDENTITY (created+matched+duplicate+skipped+rejected+deduped+unprocessed =
// rows_total, exactly, on the durable row), and T5 IDEMPOTENCY (job-level Idempotency-Key collapse; a
// terminal-skip replay is a no-op; a content-hash re-import lands `skipped`). Real Postgres via
// Testcontainers (or ITEST_DATABASE_URL); NO Redis — the wrapper is exercised directly, exactly as the
// bulk-imports consumer invokes it (the queue transport is proven by imports.queue.itest.ts already).
// Run explicitly, own process: bun test apps/workers/test/importFast.parity.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "../../../packages/db/test/itestDb.ts";

type Core = typeof import("@leadwolf/core");
type Db = typeof import("@leadwolf/db");
let core: Core;
let dbm: Db;

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let tenantA = "";
let wsLegacy = "";
let wsFast = "";
let ownerA = "";

const MAPPING = {
  email: "Email",
  firstName: "First Name",
  lastName: "Last Name",
  accountName: "Company",
  accountDomain: "Domain",
};
// Two valid identities + one reject (no identity key) → created 2 / rejected 1 in BOTH engines.
const ROWS = [
  {
    Email: "jane@acme.com",
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
  { Email: "", "First Name": "Ghost", "Last Name": "NoKey", Company: "", Domain: "" },
];

async function seedWorkspace(
  slug: string,
  tenantId?: string,
): Promise<{ tenantId: string; workspaceId: string; ownerId: string }> {
  let tid = tenantId;
  let uid: string;
  if (!tid) {
    const [t] =
      await admin`INSERT INTO tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
    tid = (t as { id: string }).id;
  }
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  uid = (u as { id: string }).id;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner) VALUES (${tid}, ${uid}, true)
    ON CONFLICT DO NOTHING`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tid}, ${slug}, ${slug}, false, ${uid}) RETURNING id`;
  return { tenantId: tid, workspaceId: (w as { id: string }).id, ownerId: uid };
}

async function contactNames(workspaceId: string): Promise<string[]> {
  const rows = await admin`
    SELECT first_name FROM contacts WHERE workspace_id = ${workspaceId} ORDER BY first_name`;
  return rows.map((r) => (r as { first_name: string }).first_name);
}

interface JobRowRaw {
  status: string;
  processing_mode: string | null;
  source_filename: string | null;
  total_chunks: number;
  completed_chunks: number;
  rows_total: number;
  rows_created: number;
  rows_matched: number;
  rows_duplicate: number;
  rows_skipped: number;
  rows_rejected: number;
  rows_deduped: number;
  rows_unprocessed: number;
  failed_reason: string | null;
}

async function jobRow(jobId: string): Promise<JobRowRaw> {
  const [r] = await admin`
    SELECT status, processing_mode, source_filename, total_chunks, completed_chunks,
           rows_total, rows_created, rows_matched, rows_duplicate, rows_skipped,
           rows_rejected, rows_deduped, rows_unprocessed, failed_reason
    FROM import_jobs WHERE id = ${jobId}`;
  return r as unknown as JobRowRaw;
}

/** Create the durable fast-mode job row exactly as the gate-on POST /imports does (routes.ts S-I3 fork). */
async function createFastJob(opts?: { idempotencyKey?: string }): Promise<{
  id: string;
  created: boolean;
}> {
  return dbm.withTenantTx({ tenantId: tenantA, workspaceId: wsFast }, (tx) =>
    dbm.importJobRepository.createJob(tx, {
      tenantId: tenantA,
      workspaceId: wsFast,
      createdByUserId: ownerA,
      sourceFile: `inline:${crypto.randomUUID()}`,
      sourceName: "manual",
      idempotencyKey: opts?.idempotencyKey ?? null,
      columnMapping: MAPPING,
      conflictPolicy: "skip",
      processingMode: "fast",
      sourceFilename: "acme.csv",
    }),
  );
}

beforeAll(async () => {
  dbHandle = await startItestDb("import_fast_parity");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../../../packages/db/src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: tenantA, workspaceId: wsLegacy, ownerId: ownerA } = await seedWorkspace("acme"));
  ({ workspaceId: wsFast } = await seedWorkspace("acme-fast", tenantA));

  // Loaded AFTER DATABASE_URL is bound (the db client is a module singleton).
  core = await import("@leadwolf/core");
  dbm = await import("@leadwolf/db");
}, 180_000);

afterAll(async () => {
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  await dbHandle?.stop();
});

describe("S-I3 T1 — flag-off/legacy vs fast-wrapper parity (same engine, same end-state)", () => {
  test("the same file through runImport (legacy) and runFastImport lands identical contacts + tallies", async () => {
    // LEGACY path — the exact engine the flag-off consumer runs (processImport is a thin shell over it).
    const legacySummary = await core.runImport({
      scope: { tenantId: tenantA, workspaceId: wsLegacy },
      importedByUserId: ownerA,
      sourceName: "manual",
      sourceFile: "acme.csv",
      mapping: MAPPING,
      conflictPolicy: "skip",
      rows: ROWS,
    });

    // FAST path — durable row + the S-I3 wrapper around the UNCHANGED engine.
    const { id: jobId, created } = await createFastJob();
    expect(created).toBe(true);
    const result = await core.runFastImport({
      scope: { tenantId: tenantA, workspaceId: wsFast },
      jobId,
      input: {
        importedByUserId: ownerA,
        sourceName: "manual",
        sourceFile: "acme.csv",
        mapping: MAPPING,
        conflictPolicy: "skip",
        rows: ROWS,
      },
    });

    // Parity of the ENGINE outcome: identical tallies, identical contact end-state per workspace.
    expect(result.created).toBe(legacySummary.created);
    expect(result.matched).toBe(legacySummary.matched);
    expect(result.skipped).toBe(legacySummary.skipped);
    expect(result.duplicate).toBe(legacySummary.duplicates);
    expect(result.rejected).toBe(legacySummary.rejected);
    expect(result.total).toBe(legacySummary.total);
    expect(await contactNames(wsFast)).toEqual(await contactNames(wsLegacy));

    // The durable delta the wrapper ADDS (G03): a terminal row with the full state trail.
    const row = await jobRow(jobId);
    expect(row.status).toBe("partial"); // 1 rejected row ⇒ partial, the honest terminal
    expect(row.processing_mode).toBe("fast");
    expect(row.source_filename).toBe("acme.csv");
    expect(row.total_chunks).toBe(1); // exactly ONE real chunk row (08 §1.1 uniform accounting)
    expect(row.completed_chunks).toBe(1);
    expect(row.rows_created).toBe(legacySummary.created);
    expect(row.rows_rejected).toBe(legacySummary.rejected);

    // The rejected-rows ledger (08 §6.1): one import_job_rows entry per rejected input line.
    const ledger = await admin`
      SELECT row_index, outcome FROM import_job_rows WHERE job_id = ${jobId} ORDER BY row_index`;
    expect(ledger.length).toBe(legacySummary.rejected);
    expect((ledger[0] as { outcome: string }).outcome).toBe("rejected");
  }, 120_000);
});

describe("S-I3 T4 — accounting identity on the durable row", () => {
  test("created+matched+duplicate+skipped+rejected+deduped+unprocessed = rows_total, exactly", async () => {
    const { id: jobId } = await createFastJob();
    await core.runFastImport({
      scope: { tenantId: tenantA, workspaceId: wsFast },
      jobId,
      input: { sourceName: "manual", mapping: MAPPING, conflictPolicy: "skip", rows: ROWS },
    });
    const row = await jobRow(jobId);
    const sum =
      row.rows_created +
      row.rows_matched +
      row.rows_duplicate +
      row.rows_skipped +
      row.rows_rejected +
      row.rows_deduped +
      row.rows_unprocessed;
    expect(sum).toBe(row.rows_total);
    expect(row.rows_total).toBe(ROWS.length);
  }, 120_000);
});

describe("S-I3 T5 — 3-level idempotency on the fast path", () => {
  test("job level: the same Idempotency-Key collapses onto the existing job", async () => {
    const first = await createFastJob({ idempotencyKey: "itest-key-1" });
    const replay = await createFastJob({ idempotencyKey: "itest-key-1" });
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.id).toBe(first.id);
  }, 60_000);

  test("terminal-skip: replaying a settled job is a no-op (no second effect, counters untouched)", async () => {
    const { id: jobId } = await createFastJob();
    const input = {
      sourceName: "manual" as const,
      mapping: MAPPING,
      conflictPolicy: "skip" as const,
      rows: ROWS,
    };
    const scope = { tenantId: tenantA, workspaceId: wsFast };
    await core.runFastImport({ scope, jobId, input });
    const before = await jobRow(jobId);
    const contactsBefore = await contactNames(wsFast);

    const replay = await core.runFastImport({ scope, jobId, input });
    expect(replay.finalized).toBe(false); // terminal-skip

    const after = await jobRow(jobId);
    expect(after).toEqual(before);
    expect(await contactNames(wsFast)).toEqual(contactsBefore);
  }, 120_000);

  test("row level: a content-hash re-import in a NEW job lands as `skipped`, never a duplicate contact", async () => {
    const contactsBefore = await contactNames(wsFast);
    const { id: jobId } = await createFastJob();
    const result = await core.runFastImport({
      scope: { tenantId: tenantA, workspaceId: wsFast },
      jobId,
      input: { sourceName: "manual", mapping: MAPPING, conflictPolicy: "skip", rows: ROWS },
    });
    // Every previously-landed row is an idempotent skip; the reject re-rejects; nothing new is created.
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.rejected).toBe(1);
    expect(await contactNames(wsFast)).toEqual(contactsBefore);

    const row = await jobRow(jobId);
    expect(row.status).toBe("partial");
    expect(row.rows_skipped).toBe(2);
  }, 120_000);
});
