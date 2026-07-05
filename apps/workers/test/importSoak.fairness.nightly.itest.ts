// importSoak.fairness.nightly.itest.ts — S-P4's TP-3: the concurrent-tenant FAIRNESS soak (import-redesign
// 12 §Testing TP-3; 15 §M-SEQ seq 41; §T-P2). This EXTENDS importFairness.itest.ts (T-Q4's mechanics half —
// admission/deferral/promotion, proven there and NOT re-proven here) with the numeric load half its header
// defers to this rig: fast-lane latency under whale load, whale in-flight ≤ K, two whales interleaving.
// Real Postgres; NO Redis (transport injected, exactly how the mechanics itest does it). Own process:
// bun test apps/workers/test/importSoak.fairness.nightly.itest.ts
//
// ── GATING — the normal suite SKIPS this file (NIGHTLY_SOAK=true to run; see importSoak.nightly.itest.ts
// for the parameter sets; the nightly CI workflow wiring is USER-OWED — only ci.yml exists in-repo).
//   smoke  (defaults): whale 30 000 rows (3 chunks), 3 fast runs of 500 rows
//   nightly (full)   : SOAK_WHALE_ROWS=2000000 — 12 §Success's "fast-lane p95 under whale load ≤ 3 min for
//                      a ≤ 5 000-row import while a 2M-row job runs"
//
// ── What is asserted vs what needs the deployed rig ────────────────────────────────────────────────────────
//   • whale in-flight ≤ K: the rolling chunk window (drive enqueues ≤ K; each completion tops up via
//     continueChunkWindow) keeps enqueued-but-unfinished chunks ≤ K at every step — asserted exactly.
//   • fast lane: SOAK_FAST_RUNS complete fast imports run CONCURRENTLY with the whale's chunk processing
//     (single Bun process ⇒ interleaved at await points — the DB does real concurrent work; the JS-side
//     time-slicing IS the contention the in-process rig can create). p95 (commit→terminal) asserted ≤
//     SOAK_FAST_P95_MS (default 180 000 — the 12 §Success 3-min bar) and reported next to the measured
//     whale chunk duration (the "fast wait ≤ one chunk duration" comparison for the nightly dashboard).
//     The QUEUE-WAIT half of that bound (a fast job parked behind whale chunks in a real BullMQ worker
//     pool) needs the deployed multi-worker rig — carried as a 16 drift note, same split T-Q4 recorded.
//   • two whales interleave: two K=1 whale jobs feeding one FIFO transport — the window mechanics
//     round-robin their chunks (neither job runs to completion before the other starts finishing).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "../../../packages/db/test/itestDb.ts";

const NIGHTLY = process.env.NIGHTLY_SOAK === "true";
const soakDescribe = NIGHTLY ? describe : describe.skip;

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const SOAK_WHALE_ROWS = intEnv("SOAK_WHALE_ROWS", 30_000); // nightly full: 2_000_000
const SOAK_FAST_ROWS = Math.min(intEnv("SOAK_FAST_ROWS", 500), 5_000); // the ≤ 5k fast-lane class
const SOAK_FAST_RUNS = intEnv("SOAK_FAST_RUNS", 3);
const SOAK_FAST_P95_MS = intEnv("SOAK_FAST_P95_MS", 180_000); // 12 §Success: ≤ 3 min under whale load
const K = 2; // the chunk window under test (09 §2.2's launch K)
const CHUNK_ROWS = 10_000;

type Core = typeof import("@leadwolf/core");
type Db = typeof import("@leadwolf/db");
let core: Core;
let dbm: Db;
let dbHandle: ItestDb;
let admin: ReturnType<typeof postgres>;
let tmpDir = "";

let whaleTenant = "";
let whaleWs = "";
let fastTenant = "";
let fastWs = "";

const MAPPING = {
  firstName: "First Name",
  lastName: "Last Name",
  email: "Email",
  accountName: "Company",
  accountDomain: "Domain",
};
const HEADER = "First Name,Last Name,Email,Company,Domain";

async function seedWorkspace(slug: string): Promise<{ tenantId: string; workspaceId: string }> {
  const [t] = await admin`
    INSERT INTO tenants (name, slug, reveal_credit_balance) VALUES (${slug}, ${slug}, 10) RETURNING id`;
  const tenantId = (t as { id: string }).id;
  const [u] = await admin`INSERT INTO users (email) VALUES (${`owner@${slug}.test`}) RETURNING id`;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, is_tenant_owner)
    VALUES (${tenantId}, ${(u as { id: string }).id}, true)`;
  const [w] = await admin`
    INSERT INTO workspaces (tenant_id, name, slug, is_default, created_by_user_id)
    VALUES (${tenantId}, ${slug}, ${slug}, true, ${(u as { id: string }).id}) RETURNING id`;
  return { tenantId, workspaceId: (w as { id: string }).id };
}

/** Stream a synthetic all-unique CSV (whale food). Generated — never a fixture on disk. */
async function* syntheticCsv(n: number, batch: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(`${HEADER}\n`, "utf8");
  let lines: string[] = [];
  for (let i = 0; i < n; i += 1) {
    lines.push(`W${i},Whale,w${i}@${batch}.test,Whale Co,${batch}.test`);
    if (lines.length >= 2_000) {
      yield Buffer.from(`${lines.join("\n")}\n`, "utf8");
      lines = [];
    }
  }
  if (lines.length > 0) yield Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

/** In-memory fast-lane rows (the ≤ 5k class travels in the payload in Phase A — S-I3). */
function fastRows(n: number, batch: string): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = [];
  for (let i = 0; i < n; i += 1) {
    rows.push({
      "First Name": `F${i}`,
      "Last Name": "Fast",
      Email: `f${i}@${batch}.test`,
      Company: "Fast Co",
      Domain: `${batch}.test`,
    });
  }
  return rows;
}

/** Create + drive a whale copy job under a K-window into a caller-owned FIFO queue (deduped — the runtime
 *  dedups via BullMQ job ids; the collector mirrors that with a Set). Returns the drive handle. */
async function driveWhale(
  scope: { tenantId: string; workspaceId: string },
  batch: string,
  rows: number,
  window: number,
  queue: Array<{ jobId: string; chunkId: string }>,
  seen: Set<string>,
) {
  const fileStore = core.diskFileStore(tmpDir);
  const sourceKey = `imports/fairness/${batch}.csv`;
  await fileStore.putObject(sourceKey, syntheticCsv(rows, batch));
  const created = await dbm.withTenantTx(scope, (tx) =>
    dbm.importJobRepository.createJob(tx, {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      sourceFile: sourceKey,
      sourceName: "manual",
      columnMapping: MAPPING,
      conflictPolicy: "skip",
    }),
  );
  const enqueue = (jobId: string, _s: unknown, chunkId: string) => {
    if (seen.has(chunkId)) return;
    seen.add(chunkId);
    queue.push({ jobId, chunkId });
  };
  const drive = await core.runBulkImport({
    scope,
    jobId: created.id,
    fileStore,
    enqueueChunk: enqueue,
    chunkWindow: window,
  });
  return { jobId: created.id, drive, enqueue };
}

beforeAll(async () => {
  if (!NIGHTLY) return;
  dbHandle = await startItestDb("import-soak-fairness");
  process.env.DATABASE_URL = dbHandle.adminUrl;
  process.env.BLIND_INDEX_KEY = "itest-blind-index-key-0123456789";

  const { applyMigrations } = await import("../../../packages/db/src/applyMigrations.ts");
  await applyMigrations(dbHandle.adminUrl);

  admin = postgres(dbHandle.adminUrl, { max: 2, onnotice: () => {} });
  ({ tenantId: whaleTenant, workspaceId: whaleWs } = await seedWorkspace("whale"));
  ({ tenantId: fastTenant, workspaceId: fastWs } = await seedWorkspace("smallfry"));
  tmpDir = await mkdtemp(join(tmpdir(), "import-soak-fairness-"));

  core = await import("@leadwolf/core");
  dbm = await import("@leadwolf/db");
}, 300_000);

afterAll(async () => {
  if (!NIGHTLY) return;
  const { closeDb } = await import("@leadwolf/db");
  await closeDb();
  await admin?.end();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  await dbHandle?.stop();
});

soakDescribe("S-P4 nightly soak — TP-3 (concurrent-tenant fairness)", () => {
  test(
    `TP-3a: fast-lane p95 ≤ ${SOAK_FAST_P95_MS}ms while a ${SOAK_WHALE_ROWS}-row whale runs; whale in-flight ≤ K=${K}`,
    async () => {
      const whaleScope = { tenantId: whaleTenant, workspaceId: whaleWs };
      const fastScope = { tenantId: fastTenant, workspaceId: fastWs };
      const batch = `whale${Date.now().toString(36)}`;

      const queue: Array<{ jobId: string; chunkId: string }> = [];
      const seen = new Set<string>();
      const { jobId: whaleJobId, enqueue } = await driveWhale(
        whaleScope,
        batch,
        SOAK_WHALE_ROWS,
        K,
        queue,
        seen,
      );
      const totalChunks = Math.ceil(SOAK_WHALE_ROWS / CHUNK_ROWS);
      // The drive respects the window from the first fan-out.
      expect(queue.length).toBeLessThanOrEqual(K);

      // Whale runner: sequential claims off the FIFO (C=1 execution; the WINDOW bound is what's under
      // test — outstanding = enqueued-not-completed may never exceed K at any observation point).
      let completed = 0;
      let maxOutstanding = 0;
      const chunkDurations: number[] = [];
      const whaleRun = (async () => {
        while (completed < totalChunks) {
          const next = queue.shift();
          if (!next) throw new Error("fairness: window starved the queue before completion");
          maxOutstanding = Math.max(maxOutstanding, seen.size - completed);
          const c0 = performance.now();
          const res = await core.bulkProcessChunk({
            scope: whaleScope,
            jobId: next.jobId,
            chunkId: next.chunkId,
          });
          chunkDurations.push(performance.now() - c0);
          expect(res.processed).toBe(true);
          completed += 1;
          await core.finalizeIfLastChunk({ scope: whaleScope, jobId: next.jobId });
          await core.continueChunkWindow({
            scope: whaleScope,
            jobId: next.jobId,
            enqueueChunk: enqueue,
            window: K,
          });
          maxOutstanding = Math.max(maxOutstanding, seen.size - completed);
        }
      })();

      // Fast lane, CONCURRENT with the whale: small-tenant imports commit→terminal under load.
      const fastDurations: number[] = [];
      const fastRun = (async () => {
        for (let r = 0; r < SOAK_FAST_RUNS; r += 1) {
          const created = await dbm.withTenantTx(fastScope, (tx) =>
            dbm.importJobRepository.createJob(tx, {
              tenantId: fastScope.tenantId,
              workspaceId: fastScope.workspaceId,
              sourceFile: `inline:${crypto.randomUUID()}`,
              sourceName: "manual",
              status: "queued",
              columnMapping: MAPPING,
              processingMode: "fast",
              sourceFilename: `fast-${r}.csv`,
            }),
          );
          const f0 = performance.now();
          const result = await core.runFastImport({
            scope: fastScope,
            jobId: created.id,
            input: {
              sourceName: "manual",
              mapping: MAPPING,
              rows: fastRows(SOAK_FAST_ROWS, `fast${r}x${Date.now().toString(36)}`),
            },
          });
          fastDurations.push(performance.now() - f0);
          expect(result.status).toBe("completed");
          expect(result.created).toBe(SOAK_FAST_ROWS);
        }
      })();

      await Promise.all([whaleRun, fastRun]);

      // Whale finished honestly…
      const whaleJob = await dbm.withTenantTx(whaleScope, (tx) =>
        dbm.importJobRepository.getJobSystem(tx, whaleJobId),
      );
      expect(whaleJob?.status).toBe("completed");
      expect(whaleJob?.rowsCreated).toBe(SOAK_WHALE_ROWS);
      // …under the window bound the whole way (TP-3's "whale in-flight ≤ K").
      expect(maxOutstanding).toBeLessThanOrEqual(K);

      // Fast-lane latency under whale load (TP-3 + 12 §Success). p95 over the runs; the "≤ one chunk
      // duration" comparison is REPORTED for the nightly dashboard (the strict form of that bound is
      // queue-wait on the deployed multi-worker rig — see header).
      const sorted = [...fastDurations].sort((a, b) => a - b);
      const p95Fast = sorted[Math.floor(sorted.length * 0.95)]!;
      const avgChunkMs =
        chunkDurations.reduce((a, b) => a + b, 0) / Math.max(chunkDurations.length, 1);
      console.info(
        `[TP-3] fast p95 ${(p95Fast / 1000).toFixed(2)}s over ${SOAK_FAST_RUNS} runs of ${SOAK_FAST_ROWS} rows (bound ${(SOAK_FAST_P95_MS / 1000).toFixed(0)}s); whale avg chunk ${(avgChunkMs / 1000).toFixed(2)}s × ${chunkDurations.length} chunks`,
      );
      expect(p95Fast).toBeLessThanOrEqual(SOAK_FAST_P95_MS);
    },
    3_600_000,
  );

  test(
    "TP-3b: two whales under K=1 windows interleave chunk-for-chunk (neither starves the other)",
    async () => {
      const whaleScope = { tenantId: whaleTenant, workspaceId: whaleWs };
      const rows = Math.min(SOAK_WHALE_ROWS, 30_000); // 3 chunks each is enough to observe interleave
      const totalChunksEach = Math.ceil(rows / CHUNK_ROWS);
      expect(totalChunksEach).toBeGreaterThanOrEqual(2); // interleave needs ≥ 2 chunks per whale

      // ONE shared FIFO transport, two K=1 jobs: the window mechanics must round-robin them.
      const queue: Array<{ jobId: string; chunkId: string }> = [];
      const seen = new Set<string>();
      const a = await driveWhale(whaleScope, `wa${Date.now().toString(36)}`, rows, 1, queue, seen);
      const b = await driveWhale(whaleScope, `wb${Date.now().toString(36)}`, rows, 1, queue, seen);

      const completions: string[] = [];
      let doneCount = 0;
      while (doneCount < totalChunksEach * 2) {
        const next = queue.shift();
        if (!next) throw new Error("fairness: shared queue starved before both whales finished");
        const res = await core.bulkProcessChunk({
          scope: whaleScope,
          jobId: next.jobId,
          chunkId: next.chunkId,
        });
        expect(res.processed).toBe(true);
        completions.push(next.jobId === a.jobId ? "A" : "B");
        doneCount += 1;
        await core.finalizeIfLastChunk({ scope: whaleScope, jobId: next.jobId });
        await core.continueChunkWindow({
          scope: whaleScope,
          jobId: next.jobId,
          enqueueChunk: next.jobId === a.jobId ? a.enqueue : b.enqueue,
          window: 1,
        });
      }

      // Both terminal.
      for (const jobId of [a.jobId, b.jobId]) {
        const job = await dbm.withTenantTx(whaleScope, (tx) =>
          dbm.importJobRepository.getJobSystem(tx, jobId),
        );
        expect(job?.status).toBe("completed");
      }

      // INTERLEAVE: each whale finishes at least one chunk before the other finishes its last —
      // an A-A-…-A-B-B-…-B (or inverse) run order would mean one whale monopolized the lane.
      console.info(`[TP-3b] completion order: ${completions.join("")}`);
      expect(completions.indexOf("B")).toBeLessThan(completions.lastIndexOf("A"));
      expect(completions.indexOf("A")).toBeLessThan(completions.lastIndexOf("B"));
    },
    3_600_000,
  );
});
