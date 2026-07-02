// reverificationQueue.ts — apps/api's BullMQ PRODUCER for ON-DEMAND freshness re-verification (data-management #3
// follow-up). The request-side sibling of the worker's daily sweep producer: an owner/admin can trigger the SAME
// bounded, idempotent per-workspace re-verification on demand instead of waiting for the daily sweep. Producer and
// consumer are decoupled by BullMQ — they share ONLY the queue NAME + the job-data type (@leadwolf/types) and the
// Redis URL (env.REDIS_URL), never each other's code, so the apps-never-import-apps boundary holds (16 §5).
//
// Lazily opened on first use so merely importing this module (mounting the home router) never dials Redis. SAFE by
// construction: the worker's runReverification re-checks the per-tenant `data_health.reverification` flag and
// NO-OPS if off — this producer only enqueues; it never forces or bypasses the flag. BullMQ requires
// maxRetriesPerRequest: null on its connection.

import { env } from "@leadwolf/config";
import {
  REVERIFICATION_QUEUE,
  type ReverificationJobData,
  type ReverificationScope,
} from "@leadwolf/types";
import { Queue } from "bullmq";
import IORedis from "ioredis";

let queue: Queue<ReverificationJobData> | undefined;
function reverificationQueue(): Queue<ReverificationJobData> {
  if (!queue) {
    const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue<ReverificationJobData>(REVERIFICATION_QUEUE, {
      connection,
      defaultJobOptions: {
        // Idempotent (only still-stale rows are touched) → a couple of backoff retries cover a transient verifier
        // outage; mirrors the worker's enqueueReverification options so on-demand + swept jobs behave identically.
        attempts: 3,
        backoff: { type: "exponential", delay: 60_000, jitter: 0.5 },
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: false,
      },
    });
  }
  return queue;
}

/** Enqueue an on-demand per-workspace re-verification (data-management #3). Idempotent + flag-gated in the worker. */
export async function enqueueReverification(scope: ReverificationScope): Promise<string> {
  const job = await reverificationQueue().add("reverify", { scope });
  return String(job.id);
}

const HEALTH_PROBE_TIMEOUT_MS = 1500;

/** Live depth/worker probe for the platform system-health surface (B2). Reuses the lazy producer singleton
 *  (no new connection per call) and THROWS on a ~1.5s timeout or Redis error so the caller's allSettled
 *  marks this queue unreachable — we never fabricate a zeroed reading. Read-only: never enqueues. */
export async function reverificationQueueHealth(): Promise<{
  name: string;
  waiting: number;
  active: number;
  failed: number;
  delayed: number;
  workers: number;
}> {
  const q = reverificationQueue();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const [counts, workers] = await Promise.all([
          q.getJobCounts("waiting", "active", "failed", "delayed"),
          q.getWorkers(),
        ]);
        return {
          name: REVERIFICATION_QUEUE,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          failed: counts.failed ?? 0,
          delayed: counts.delayed ?? 0,
          workers: workers.length,
        };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${REVERIFICATION_QUEUE} health probe timed out`)),
          HEALTH_PROBE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
