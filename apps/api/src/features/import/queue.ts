// queue.ts — the import feature's BullMQ *producer*. The API parses the CSV, then enqueues a RunImportInput
// onto the shared `imports` queue; the apps/workers *consumer* (processImport) drains it and runs the SAME
// packages/core pipeline (one implementation, two transports — 16 §3.2). Producer and consumer are decoupled
// by BullMQ: they share only the queue NAME (IMPORTS_QUEUE, @leadwolf/types) and the Redis URL
// (env.REDIS_URL) — never each other's code, so the `apps-never-import-apps` boundary holds (16 §5).

import { env } from "@leadwolf/config";
import type { RunImportInput } from "@leadwolf/core";
import { IMPORTS_QUEUE } from "@leadwolf/types";
import { type Job, Queue } from "bullmq";
import IORedis from "ioredis";
import { assertQueueCapacity } from "./queueBackpressure.ts";

/** The job payload IS a RunImportInput — rows are parsed on the API before enqueue (parse stays API-side, M1). */
export type ImportJobData = RunImportInput;

// Lazily opened on first use so merely importing this module (e.g. mounting the router) never dials Redis.
// BullMQ requires maxRetriesPerRequest: null on its connection.
let queue: Queue<ImportJobData> | undefined;
function importQueue(): Queue<ImportJobData> {
  if (!queue) {
    const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue<ImportJobData>(IMPORTS_QUEUE, {
      connection,
      defaultJobOptions: {
        // Retry transient/systemic failures with exponential backoff + jitter (de-correlates retries under a
        // shared outage — 0.1); the worker dead-letters on exhaustion.
        attempts: 3,
        backoff: { type: "exponential", delay: 2000, jitter: 0.5 },
        // Retain terminal jobs briefly so the status endpoint can be polled after the job settles.
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: false,
      },
    });
  }
  return queue;
}

/** Above this many already-waiting imports, new submissions shed with a typed 503 (Phase 5 backpressure).
 *  Each job carries its parsed rows in the payload, so an unbounded backlog is also a Redis-memory risk. */
const MAX_WAITING_IMPORTS = 10_000;

/** Enqueue a parsed import for background processing; returns the BullMQ job id the importer can poll.
 *  Sheds with a typed 503 (queue_backpressure) when the queue is already saturated — degrade at the door,
 *  never cascade (worker-platform plan 15 §7; doc 18 §9). */
export async function enqueueImport(data: ImportJobData): Promise<string> {
  const q = importQueue();
  await assertQueueCapacity(q, IMPORTS_QUEUE, MAX_WAITING_IMPORTS);
  const job = await q.add("import", data);
  return String(job.id);
}

/** Fetch an import job by id for status polling; undefined if unknown (never enqueued, or evicted). */
export async function getImportJob(jobId: string): Promise<Job<ImportJobData> | undefined> {
  return importQueue().getJob(jobId);
}

const HEALTH_PROBE_TIMEOUT_MS = 1500;

/** Live depth/worker probe for the platform system-health surface (B2). Reuses the lazy producer singleton
 *  (no new connection per call) and THROWS on a ~1.5s timeout or Redis error so the caller's allSettled
 *  marks this queue unreachable — we never fabricate a zeroed reading. Read-only: never enqueues. */
export async function importQueueHealth(): Promise<{
  name: string;
  waiting: number;
  active: number;
  failed: number;
  delayed: number;
  workers: number;
}> {
  const q = importQueue();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const [counts, workers] = await Promise.all([
          q.getJobCounts("waiting", "active", "failed", "delayed"),
          q.getWorkers(),
        ]);
        return {
          name: IMPORTS_QUEUE,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          failed: counts.failed ?? 0,
          delayed: counts.delayed ?? 0,
          workers: workers.length,
        };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${IMPORTS_QUEUE} health probe timed out`)),
          HEALTH_PROBE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
