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
        backoff: { type: "exponential", delay: 60_000 },
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
