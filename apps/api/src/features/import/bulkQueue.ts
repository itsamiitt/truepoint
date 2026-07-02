// bulkQueue.ts — the BULK import feature's BullMQ *producer* (backlog #2, phase 6). The big-file sibling of
// queue.ts: instead of parsing the CSV and enqueuing the rows, the API streams the upload to the FileStore,
// creates the control row, then enqueues a single `drive` job onto the dedicated `bulk-imports` queue; the
// apps/workers consumer (processBulkImport) stages the file + fans out the `chunk` jobs (one implementation, two
// transports — 16 §3.2). Producer and consumer are decoupled by BullMQ: they share only the queue NAME
// (BULK_IMPORTS_QUEUE, @leadwolf/types) and the Redis URL (env.REDIS_URL) — never each other's code, so the
// apps-never-import-apps boundary holds (16 §5). The chunk fan-out producer lives in the worker (the drive's
// injected enqueueChunk); the API only ever enqueues the initial drive.

import { env } from "@leadwolf/config";
import { BULK_IMPORTS_QUEUE, type BulkImportJobData } from "@leadwolf/types";
import { Queue } from "bullmq";
import IORedis from "ioredis";

/** Only the API enqueues the DRIVE variant; the worker enqueues the chunk variant onto the same queue. */
type BulkImportDriveJobData = Extract<BulkImportJobData, { kind: "drive" }>;

// Lazily opened on first use so merely importing this module (e.g. mounting the router) never dials Redis — the
// feature is DARK until the bulk gate opens (the global env.BULK_IMPORT_ENABLED kill-switch AND the per-tenant
// `bulk_import_enabled` flag), and the route gates on BOTH before ever calling the producer, so the producer is
// never reached while gated. BullMQ requires maxRetriesPerRequest: null on its connection.
let queue: Queue<BulkImportJobData> | undefined;
function bulkImportQueue(): Queue<BulkImportJobData> {
  if (!queue) {
    const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue<BulkImportJobData>(BULK_IMPORTS_QUEUE, {
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

/** Enqueue the DRIVE job for a freshly-created bulk import; the worker stages the file + fans out the chunks. */
export async function enqueueBulkImportDrive(data: BulkImportDriveJobData): Promise<string> {
  const job = await bulkImportQueue().add("drive", data);
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
