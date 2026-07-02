// bulkRevealQueue.ts — the async bulk-reveal feature's BullMQ *producer* (reveal-experience Phase 3). The
// sibling of enrichment/bulkEnrichQueue.ts: once a bulk-reveal job is CONFIRMED (awaiting_confirmation →
// running, the lease step), the API enqueues a single `drive` job onto the dedicated `bulk-reveal` queue; the
// apps/workers consumer chunks it + fans out `chunk` jobs. Producer and consumer share only the queue NAME
// (BULK_REVEAL_QUEUE, @leadwolf/types) + the Redis URL — never each other's code (apps-never-import-apps).

import { env } from "@leadwolf/config";
import { BULK_REVEAL_QUEUE, type BulkRevealJobData } from "@leadwolf/types";
import { Queue } from "bullmq";
import IORedis from "ioredis";

type BulkRevealDriveJobData = Extract<BulkRevealJobData, { kind: "drive" }>;

// Lazily opened so importing this module never dials Redis — the pipeline is DARK until BULK_REVEAL_ENABLED is on.
let queue: Queue<BulkRevealJobData> | undefined;
function bulkRevealQueue(): Queue<BulkRevealJobData> {
  if (!queue) {
    const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue<BulkRevealJobData>(BULK_REVEAL_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000, jitter: 0.5 },
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: false,
      },
    });
  }
  return queue;
}

/**
 * Enqueue the DRIVE job for a CONFIRMED bulk-reveal run. SPEND-SAFE GATE: while env.BULK_REVEAL_ENABLED is off
 * this enqueues NOTHING and returns null (the pipeline stays dark end-to-end). Enforced here in the producer
 * (defense in depth) as well as at the route. Returns the BullMQ job id when enqueued, else null.
 */
export async function enqueueBulkRevealDrive(data: BulkRevealDriveJobData): Promise<string | null> {
  if (!env.BULK_REVEAL_ENABLED) return null;
  const job = await bulkRevealQueue().add("drive", data);
  return String(job.id);
}
