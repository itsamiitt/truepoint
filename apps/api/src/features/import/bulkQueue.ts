// bulkQueue.ts — the BULK import feature's BullMQ *producer* (backlog #2, phase 6). The big-file sibling of
// queue.ts: instead of parsing the CSV and enqueuing the rows, the API streams the upload to the FileStore,
// creates the control row, then enqueues a single `drive` job onto the dedicated `bulk-imports` queue; the
// apps/workers consumer (processBulkImport) stages the file + fans out the `chunk` jobs (one implementation, two
// transports — 16 §3.2). Producer and consumer are decoupled by BullMQ: they share only the queue NAME
// (BULK_IMPORTS_QUEUE, @leadwolf/types) and the Redis URL (env.REDIS_URL) — never each other's code, so the
// apps-never-import-apps boundary holds (16 §5). The chunk fan-out producer lives in the worker (the drive's
// injected enqueueChunk); the API only ever enqueues the initial drive.

import { env } from "@leadwolf/config";
import {
  BULK_IMPORTS_QUEUE,
  type BulkImportJobData,
  IMPORT_QUEUE_PRIORITY,
  type ImportFastJobData,
} from "@leadwolf/types";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { assertQueueCapacity } from "./queueBackpressure.ts";

/** Only the API enqueues the DRIVE variant; the worker enqueues the chunk variant onto the same queue. */
type BulkImportDriveJobData = Extract<BulkImportJobData, { kind: "drive" }>;

/** The unified `bulk-imports` payload union (09 §1.1): the legacy drive/chunk kinds + the v2 `fast` lane
 *  (importV2.ts, S-I3). One queue, priority bands — never a second import execution queue. */
type UnifiedImportJobData = BulkImportJobData | ImportFastJobData;

// Lazily opened on first use so merely importing this module (e.g. mounting the router) never dials Redis — the
// feature is DARK until the bulk gate opens (the global env.BULK_IMPORT_ENABLED kill-switch AND the per-tenant
// `bulk_import_enabled` flag), and the route gates on BOTH before ever calling the producer, so the producer is
// never reached while gated. BullMQ requires maxRetriesPerRequest: null on its connection.
let queue: Queue<UnifiedImportJobData> | undefined;
function bulkImportQueue(): Queue<UnifiedImportJobData> {
  if (!queue) {
    const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue<UnifiedImportJobData>(BULK_IMPORTS_QUEUE, {
      connection,
      defaultJobOptions: {
        // Retry transient/systemic failures with exponential backoff + jitter (de-correlates retries under a
        // shared outage — 0.1); the worker dead-letters on exhaustion.
        attempts: 3,
        backoff: { type: "exponential", delay: 2000, jitter: 0.5 },
        // Retain terminal jobs briefly (the status surface reads the DB control row, but this aids ops triage).
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: false,
      },
    });
  }
  return queue;
}

/** Above this many already-waiting drives, new bulk imports shed with a typed 503 (Phase 5 backpressure).
 *  Each drive fans out a whole job's chunks, so the drive queue saturates far earlier than the row queue. */
const MAX_WAITING_DRIVES = 1_000;

/** Enqueue the DRIVE job for a freshly-created bulk import; the worker stages the file + fans out the chunks.
 *  Sheds with a typed 503 (queue_backpressure) when the drive queue is already saturated (plan 15 §7). */
export async function enqueueBulkImportDrive(data: BulkImportDriveJobData): Promise<string> {
  const q = bulkImportQueue();
  await assertQueueCapacity(q, BULK_IMPORTS_QUEUE, MAX_WAITING_DRIVES);
  // S-Q1 (09 §1.1/§1.2): copy-drive priority band + STABLE jobId `import-drive:<jobId>` — a duplicate
  // publish (reaper re-drive, replayed intent) dedupes at the queue; the drive itself is watermark-resumable
  // so a re-execution never re-stages. Dark behind BULK_IMPORT_ENABLED like everything on this route.
  const job = await q.add("drive", data, {
    priority: IMPORT_QUEUE_PRIORITY.copyDrive,
    jobId: `import-drive:${data.jobId}`,
  });
  return String(job.id);
}

/** Above this many already-waiting jobs on the unified queue, fast submissions shed with a typed 503 — the
 *  legacy `imports` queue's posture carried over (fast payloads carry rows, so an unbounded backlog is a
 *  Redis-memory risk exactly as it is there; the Phase-A transport bound, importV2.ts). */
const MAX_WAITING_FAST = 10_000;

/**
 * Enqueue a v2 FAST import onto the unified `bulk-imports` queue (09 §1.1, S-I3) — priority band `fast`
 * (jumps every waiting copy chunk), STABLE jobId `import-fast:<jobId>` so an at-least-once re-publish
 * dedupes at the queue (the consumer's terminal-skip catches the rest). Called ONLY behind the
 * IMPORT_V2_ENABLED dual gate — the legacy path never reaches this producer. `delayMs` is the S-Q2
 * deferred-lane re-check delay (0 = claimable immediately).
 */
export async function enqueueFastImport(data: ImportFastJobData, delayMs = 0): Promise<string> {
  const q = bulkImportQueue();
  await assertQueueCapacity(q, BULK_IMPORTS_QUEUE, MAX_WAITING_FAST);
  const job = await q.add("fast", data, {
    priority: IMPORT_QUEUE_PRIORITY.fast,
    // Deferral re-enqueues carry a suffixed id (a completed stable id would otherwise dedupe them away).
    jobId: data.deferrals ? `import-fast:${data.jobId}:r${data.deferrals}` : `import-fast:${data.jobId}`,
    delay: delayMs > 0 ? delayMs : undefined,
  });
  return String(job.id);
}

const HEALTH_PROBE_TIMEOUT_MS = 1500;

/** Live depth/worker probe for the platform system-health surface (B2). Reuses the lazy producer singleton
 *  (no new connection per call) and THROWS on a ~1.5s timeout or Redis error so the caller's allSettled
 *  marks this queue unreachable — we never fabricate a zeroed reading. Read-only: never enqueues, never opens
 *  the bulk gate (it only reads queue depth from the same Redis). */
export async function bulkQueueHealth(): Promise<{
  name: string;
  waiting: number;
  active: number;
  failed: number;
  delayed: number;
  workers: number;
}> {
  const q = bulkImportQueue();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const [counts, workers] = await Promise.all([
          q.getJobCounts("waiting", "active", "failed", "delayed"),
          q.getWorkers(),
        ]);
        return {
          name: BULK_IMPORTS_QUEUE,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          failed: counts.failed ?? 0,
          delayed: counts.delayed ?? 0,
          workers: workers.length,
        };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${BULK_IMPORTS_QUEUE} health probe timed out`)),
          HEALTH_PROBE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
