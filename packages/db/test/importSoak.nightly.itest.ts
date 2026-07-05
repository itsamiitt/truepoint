// importSoak.nightly.itest.ts — S-P4's soak entrypoints (import-and-data-model-redesign 12 §Testing; 15 §M-SEQ
// seq 41; §T-P2): TP-2 (the 2M-row soak), TP-6 (constant-memory through the FULL drive) and TP-4 (the poll
// fingerprint probe) as runnable bun-test files. Real Postgres via itestDb.ts; own process (module-singleton
// db client): bun test ./packages/db/test/importSoak.nightly.itest.ts
//
// ── GATING — the normal suite SKIPS this file ────────────────────────────────────────────────────────────────
// Everything here is behind NIGHTLY_SOAK=true (the CI itest sweep globs *.itest.ts, so on PR runs this file
// loads, reports its describes as skipped, and exits green in milliseconds — no container, no DB). The
// nightly CI workflow wiring is USER-OWED (only .github/workflows/ci.yml exists — there is no nightly
// workflow in-repo yet); the intended parameter sets:
//
//   PR smoke      : (skipped — NIGHTLY_SOAK unset)
//   nightly smoke : NIGHTLY_SOAK=true                                  (defaults: SOAK_ROWS=10 000)
//   nightly full  : NIGHTLY_SOAK=true SOAK_ROWS=2000000                (THE TP-2 parameter — 12 §1.2's 2M
//                   reference file; wall budget auto-scales to the 12 §Success bar: ≤ 90 min at C=1)
//
// The §5 published-ceiling raise (1M → 2M rows/file) is gated on the FULL run green (12 §Rollout) — a smoke
// green is a plumbing check, never the raise trigger.
//
// ── What is asserted (hard) vs reported (console.info, for the nightly dashboard) ──────────────────────────
//   TP-2 : job reaches `completed`; the ACCOUNTING IDENTITY (Σ of the seven outcome counters +
//          rows_unprocessed === rows_total — 08 T4's assertion reused); import_job_rows ledger count ===
//          rows_total (valid because the generated rows are all-unique: no dedup/reject bucket diverts —
//          the shipped pipeline writes NO ledger row for staging-deduped rows, by design); staging table
//          dropped on finalize; total wall time ≤ SOAK_WALL_BUDGET_MS (default scales the 90-min/2M §Success
//          bar linearly with SOAK_ROWS, floored at 3 min for small-N fixed overhead). Per-stage splits
//          (drive vs chunks, ≈ 12 §1.2 stages 3–4 vs 6) are REPORTED — the per-stage §1.2 budgets are only
//          meaningful at the nightly 2M parameter, so they are not hard-asserted at smoke scale.
//   TP-6 : RSS is sampled on a timer THROUGH the whole drive (stream-parse + prepareContact crypto + COPY —
//          the full stage, not just the loader; the §3.2-criterion-3 property one level up): delta ≤
//          SOAK_DRIVE_MAX_RSS_DELTA_MB (default 256 — the loader's 128 MB class with 2× headroom for parse
//          buffers + per-row crypto; the number is fixed HERE, 12 names the property) and PLATEAUS
//          (second-half growth ≤ 64 MB — independent of row count).
//   TP-4 : the poll fingerprint — the exact ETag basis 12 §8 names, (status, counters, completed_chunks) —
//          is STABLE between chunk completions (byte-identical fingerprint ⇒ a conditional GET would 304)
//          and CHANGES after one (⇒ 200 with a new ETag); poll read = one PK read, latency sampled.
//          The HTTP half (real ETag header / If-None-Match → 304 / Cache-Control: private, max-age=2 /
//          the per-route rate limiter) is NOT SHIPPED yet on GET /imports/:id — test.todo below marks it;
//          16's drift log carries it. Fairness (TP-3) lives in apps/workers/test/ (it extends T-Q4's rig).
//
// NO pipeline code is touched — this composes the real entry points (runBulkImport / bulkProcessChunk /
// finalizeIfLastChunk) exactly like bulkImport.pipeline.itest.ts, at parameterized scale. Rows are
// GENERATED (streamed into the FileStore) — nothing large ever lands on disk in the repo or in memory.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ColumnMapping, SourceName } from "@leadwolf/types";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

const NIGHTLY = process.env.NIGHTLY_SOAK === "true";
// describe.skip keeps the file green-and-fast on PR runs; hooks inside a skipped describe never run.
const soakDescribe = NIGHTLY ? describe : describe.skip;

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── Parameters (nightly overrides; defaults = smoke) ────────────────────────────────────────────────────────
const SOAK_ROWS = intEnv("SOAK_ROWS", 10_000); // nightly full: 2_000_000 (12 §1.2's reference file)
// Wall budget: the 12 §Success bar (2M ≤ 90 min at C=1) scaled linearly, floored for small-N fixed overhead.
const SOAK_WALL_BUDGET_MS = intEnv(
  "SOAK_WALL_BUDGET_MS",
  Math.max(180_000, Math.round((SOAK_ROWS / 2_000_000) * 90 * 60_000)),
);
const SOAK_DRIVE_MAX_RSS_DELTA_BYTES = intEnv("SOAK_DRIVE_MAX_RSS_DELTA_MB", 256) * 1024 * 1024;
const SOAK_PLATEAU_GROWTH_BYTES = 64 * 1024 * 1024;
// TP-4 runs at a small FIXED size (3 chunks) — fingerprint semantics don't need scale.
const POLL_PROBE_ROWS = 25_000;

const CHUNK_ROWS = 10_000; // mirrors runBulkImport's band size (a tuning target, 15 §6)

type Db = typeof import("@leadwolf/db");
type Core = typeof import("../../core/src/index.ts");

let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let db: Db;
let core: Core;
let tenantId = "";
let workspaceId = "";
let tmpDir = "";

const SOURCE_NAME: SourceName = "manual";
const MAPPING: ColumnMapping = {
  firstName: "First Name",
  lastName: "Last Name",
  email: "Email",
  jobTitle: "Title",
  accountName: "Company",
  accountDomain: "Domain",
};
const HEADER = "First Name,Last Name,Email,Title,Company,Domain";

const scope = () => ({ tenantId, workspaceId });

/** Stream a synthetic all-unique CSV (header + n rows) — unique emails ⇒ every row lands `created` (no
 *  dedup/reject bucket diverts), which is what makes TP-2's ledger-count assertion exact. */
async function* syntheticCsv(n: number, batch: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(`${HEADER}\n`, "utf8");
  const BATCH_LINES = 2_000;
  let lines: string[] = [];
  for (let i = 0; i < n; i += 1) {
    lines.push(`S${i},Oak,u${i}@${batch}.test,Engineer,Soak Co,${batch}.test`);
    if (lines.length >= BATCH_LINES) {
      yield Buffer.from(`${lines.join("\n")}\n`, "utf8");
      lines = [];
    }
  }
  if (lines.length > 0) yield Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

/** The poll fingerprint — EXACTLY the ETag basis 12 §8 names: (status, counters, completed_chunks). */
function pollFingerprint(job: {
  status: string;
  rowsTotal: number;
  rowsCreated: number;
  rowsMatched: number;
  rowsDuplicate: number;
  rowsSkipped: number;
  rowsRejected: number;
  rowsDeduped: number;
  rowsUnprocessed: number;
  completedChunks: number;
}): string {
  return JSON.stringify([
    job.status,
    job.rowsTotal,
    job.rowsCreated,
    job.rowsMatched,
    job.rowsDuplicate,
    job.rowsSkipped,
    job.rowsRejected,
    job.rowsDeduped,
    job.rowsUnprocessed,
    job.completedChunks,
  ]);
}

async function pollJob(jobId: string) {
  const job = await db.withTenantTx(scope(), (tx) => db.importJobRepository.getJobSystem(tx, jobId));
  if (!job) throw new Error(`soak: job ${jobId} vanished`);
  return job;
}

/** Drive + process a whole bulk job at C=1 (sequential chunks), returning the timing splits. */
async function runWholeJob(rows: number, batch: string) {
  const fileStore = core.diskFileStore(tmpDir);
  const sourceKey = `imports/soak/${batch}.csv`;
  await fileStore.putObject(sourceKey, syntheticCsv(rows, batch));

  const created = await db.withTenantTx(scope(), (tx) =>
    db.importJobRepository.createJob(tx, {
      tenantId,
      workspaceId,
      sourceFile: sourceKey,
      sourceName: SOURCE_NAME,
      columnMapping: MAPPING,
      conflictPolicy: "skip",
    }),
  );

  const collected: string[] = [];
  const t0 = performance.now();
  const driveResult = await core.runBulkImport({
    scope: scope(),
    jobId: created.id,
    fileStore,
    enqueueChunk: (_jobId, _scope, chunkId) => {
      collected.push(chunkId);
    },
  });
  const driveMs = performance.now() - t0;

  const chunkDurations: number[] = [];
  for (const chunkId of collected) {
    const c0 = performance.now();
    const res = await core.bulkProcessChunk({ scope: scope(), jobId: created.id, chunkId });
    chunkDurations.push(performance.now() - c0);
    if (!res.processed) throw new Error(`soak: chunk ${chunkId} did not process`);
    await core.finalizeIfLastChunk({ scope: scope(), jobId: created.id });
  }
  const totalMs = performance.now() - t0;
  return { jobId: created.id, driveResult, driveMs, chunkDurations, totalMs };
}

beforeAll(async () => {
  if (!NIGHTLY) return; // PR runs: no container, no DB, nothing
  dbHandle = await startItestDb("import-soak");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  const [t] = await admin`
    INSERT INTO tenants (name, slug, reveal_credit_balance) VALUES ('soak', 'soak', 10) RETURNING id`;
  tenantId = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES ('owner@soak.test') RETURNING id`;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner)
    VALUES (${tenantId}, ${(u as { id: string }).id}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, 'soak', 'soak', true, ${(u as { id: string }).id}) RETURNING id`;
  workspaceId = (w as { id: string }).id;
  tmpDir = await mkdtemp(join(tmpdir(), "import-soak-"));

  // Env is set above BEFORE these dynamic imports load @leadwolf/config / the db singleton (the same
  // source-barrel trick as bulkImport.pipeline.itest.ts — no packages/db → @leadwolf/core devDep).
  db = await import("@leadwolf/db");
  core = await import("../../core/src/index.ts");
}, 300_000);

afterAll(async () => {
  if (!NIGHTLY) return;
  await db?.closeDb();
  await admin?.end();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  await dbHandle?.stop();
});

soakDescribe("S-P4 nightly soak — TP-2 (2M soak) + TP-6 (drive memory plateau)", () => {
  test(
    `TP-2/TP-6: ${SOAK_ROWS}-row soak — accounting identity, ledger count, wall budget, drive RSS plateau`,
    async () => {
      // TP-6's sampler: RSS on a timer through the WHOLE run (drive incl. parse+prepare+COPY, then chunks).
      (globalThis as unknown as { Bun?: { gc?: (f: boolean) => void } }).Bun?.gc?.(true);
      const baselineRss = process.memoryUsage().rss;
      const driveSamples: number[] = [];
      let sampling = true;
      const sampler = setInterval(() => {
        if (sampling) driveSamples.push(process.memoryUsage().rss);
      }, 500);

      let result: Awaited<ReturnType<typeof runWholeJob>>;
      try {
        result = await runWholeJob(SOAK_ROWS, `soak${Date.now().toString(36)}`);
      } finally {
        sampling = false;
        clearInterval(sampler);
      }
      const { jobId, driveResult, driveMs, chunkDurations, totalMs } = result;

      // ── TP-2: shape, terminal, identity, ledger, budget ────────────────────────────────────────────────
      expect(driveResult.status).toBe("staged");
      expect(driveResult.totalChunks).toBe(Math.ceil(SOAK_ROWS / CHUNK_ROWS));
      expect(driveResult.stage?.total).toBe(SOAK_ROWS);
      expect(driveResult.stage?.rejected).toBe(0);
      expect(driveResult.stage?.dedupedInFile).toBe(0);

      const job = await pollJob(jobId);
      expect(job.status).toBe("completed");
      expect(job.rowsTotal).toBe(SOAK_ROWS);
      expect(job.rowsCreated).toBe(SOAK_ROWS); // all-unique input ⇒ every row created
      // THE ACCOUNTING IDENTITY (08 T4; 09 §8's S1 alert is this, in production form).
      const accounted =
        job.rowsCreated +
        job.rowsMatched +
        job.rowsDuplicate +
        job.rowsSkipped +
        job.rowsRejected +
        job.rowsDeduped +
        job.rowsUnprocessed;
      expect(accounted).toBe(job.rowsTotal);

      // Ledger: one import_job_rows row per processed survivor === rows_total (all-unique input).
      const [ledger] = (await admin`
        SELECT count(*)::int AS n FROM import_job_rows WHERE job_id = ${jobId}`) as { n: number }[];
      expect(ledger!.n).toBe(SOAK_ROWS);

      // Staging table dropped on finalize.
      const stagingName = db.importStagingRepository.stagingTableName(jobId);
      const [reg] = (await admin`SELECT to_regclass(${stagingName}) AS t`) as { t: string | null }[];
      expect(reg!.t).toBeNull();

      // Wall budget (the §Success bar, scaled) + the per-stage report for the nightly dashboard.
      const avgChunkMs = chunkDurations.reduce((a, b) => a + b, 0) / Math.max(chunkDurations.length, 1);
      console.info(
        `[TP-2] ${SOAK_ROWS} rows: total ${(totalMs / 1000).toFixed(1)}s (budget ${(SOAK_WALL_BUDGET_MS / 1000).toFixed(0)}s) — drive ${(driveMs / 1000).toFixed(1)}s (≈ stages 3–4), ${chunkDurations.length} chunks avg ${(avgChunkMs / 1000).toFixed(2)}s (≈ stage 6)`,
      );
      expect(totalMs).toBeLessThanOrEqual(SOAK_WALL_BUDGET_MS);

      // ── TP-6: constant memory through the full run ─────────────────────────────────────────────────────
      const deltas = driveSamples.map((s) => s - baselineRss);
      expect(deltas.length).toBeGreaterThan(1); // the sampler must have observed the run
      const overallMax = Math.max(...deltas);
      const mid = Math.floor(deltas.length / 2);
      const firstHalfMax = Math.max(...deltas.slice(0, Math.max(mid, 1)));
      console.info(
        `[TP-6] RSS delta max ${(overallMax / 1024 / 1024).toFixed(1)} MB (first half ${(firstHalfMax / 1024 / 1024).toFixed(1)} MB, ${deltas.length} samples, bound ${(SOAK_DRIVE_MAX_RSS_DELTA_BYTES / 1024 / 1024).toFixed(0)} MB)`,
      );
      expect(overallMax).toBeLessThanOrEqual(SOAK_DRIVE_MAX_RSS_DELTA_BYTES);
      expect(overallMax - firstHalfMax).toBeLessThanOrEqual(SOAK_PLATEAU_GROWTH_BYTES);
    },
    SOAK_WALL_BUDGET_MS + 900_000,
  );
});

soakDescribe("S-P4 nightly soak — TP-4 (poll fingerprint probe)", () => {
  test(
    "TP-4: the (status, counters, completed_chunks) fingerprint is stable between chunk completions and changes after one",
    async () => {
      const fileStore = core.diskFileStore(tmpDir);
      const batch = `poll${Date.now().toString(36)}`;
      const sourceKey = `imports/soak/${batch}.csv`;
      await fileStore.putObject(sourceKey, syntheticCsv(POLL_PROBE_ROWS, batch));

      const created = await db.withTenantTx(scope(), (tx) =>
        db.importJobRepository.createJob(tx, {
          tenantId,
          workspaceId,
          sourceFile: sourceKey,
          sourceName: SOURCE_NAME,
          columnMapping: MAPPING,
          conflictPolicy: "skip",
        }),
      );
      const jobId = created.id;
      const collected: string[] = [];
      await core.runBulkImport({
        scope: scope(),
        jobId,
        fileStore,
        enqueueChunk: (_j, _s, chunkId) => {
          collected.push(chunkId);
        },
      });
      expect(collected.length).toBe(Math.ceil(POLL_PROBE_ROWS / CHUNK_ROWS)); // 3 chunks

      // Between completions: two polls ⇒ IDENTICAL fingerprint (a conditional GET would 304).
      const fp1 = pollFingerprint(await pollJob(jobId));
      const fp2 = pollFingerprint(await pollJob(jobId));
      expect(fp2).toBe(fp1);

      // A chunk completes ⇒ the fingerprint CHANGES (counters + completed_chunks moved) ⇒ 200, new ETag.
      const res = await core.bulkProcessChunk({ scope: scope(), jobId, chunkId: collected[0]! });
      expect(res.processed).toBe(true);
      await core.finalizeIfLastChunk({ scope: scope(), jobId });
      const fp3 = pollFingerprint(await pollJob(jobId));
      expect(fp3).not.toBe(fp1);

      // Quiet again ⇒ stable again.
      expect(pollFingerprint(await pollJob(jobId))).toBe(fp3);

      // Poll cost: one PK read. Latency sampled (report; generous hard bound only — the production
      // "poll p95 < 10 ms" §Success number is an API-route SLO measured on the deployed rig, not here).
      const latencies: number[] = [];
      for (let i = 0; i < 50; i += 1) {
        const p0 = performance.now();
        await pollJob(jobId);
        latencies.push(performance.now() - p0);
      }
      latencies.sort((a, b) => a - b);
      const p95 = latencies[Math.floor(latencies.length * 0.95)]!;
      console.info(`[TP-4] poll p95 ${p95.toFixed(1)}ms over ${latencies.length} PK reads`);
      expect(p95).toBeLessThanOrEqual(100);

      // Drain the job so the workspace is clean for other scenarios.
      for (const chunkId of collected.slice(1)) {
        await core.bulkProcessChunk({ scope: scope(), jobId, chunkId });
        await core.finalizeIfLastChunk({ scope: scope(), jobId });
      }
      expect((await pollJob(jobId)).status).toBe("completed");
    },
    600_000,
  );

  // The HTTP half of TP-4 — a real ETag header on GET /imports/:id, If-None-Match ⇒ 304,
  // `Cache-Control: private, max-age=2`, and the per-route rate limiter engaging before measurable DB load
  // (12 §8) — is NOT SHIPPED on the route yet (no ETag/Cache-Control writer exists in apps/api). The probe
  // above proves the fingerprint SEMANTICS the header will carry. Wire the header, then turn this into a
  // real HTTP itest against the route. 16's drift log tracks it.
  test.todo("TP-4 (HTTP): ETag/304 + Cache-Control: private, max-age=2 on GET /imports/:id — route header not shipped yet");
});
