// bulkEnrichQueue.ts — the BULK enrichment feature's BullMQ *producer* (prospect-database-platform I3 / audit
// A3/P08). The sibling of import/bulkQueue.ts: once a bulk-enrich job is CONFIRMED (awaiting_confirmation →
// running, slice 1b), the API enqueues a single `drive` job onto the dedicated `bulk-enrichment` queue; the
// apps/workers consumer chunks the job + fans out `chunk` jobs (one implementation, two transports — 16 §3.2).
// Producer and consumer are decoupled by BullMQ: they share only the queue NAME (BULK_ENRICHMENT_QUEUE,
// @leadwolf/types) and the Redis URL (env.REDIS_URL) — never each other's code, so apps-never-import-apps holds.

import { env } from "@leadwolf/config";
import { BULK_ENRICHMENT_QUEUE, type BulkEnrichmentJobData } from "@leadwolf/types";
import { Queue } from "bullmq";
import IORedis from "ioredis";

/** Only the API enqueues the DRIVE variant; the worker enqueues the chunk variant onto the same queue. */
type BulkEnrichmentDriveJobData = Extract<BulkEnrichmentJobData, { kind: "drive" }>;

// Lazily opened on first use so merely importing this module never dials Redis — the pipeline is DARK until the
// global env.BULK_ENRICHMENT_ENABLED kill-switch is on, and the producer self-gates below, so it is never reached
// while gated. BullMQ requires maxRetriesPerRequest: null on its connection.
let queue: Queue<BulkEnrichmentJobData> | undefined;
function bulkEnrichmentQueue(): Queue<BulkEnrichmentJobData> {
  if (!queue) {
    const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue<BulkEnrichmentJobData>(BULK_ENRICHMENT_QUEUE, {
      connection,
      defaultJobOptions: {
        // Retry transient/systemic failures with exponential backoff; the worker dead-letters on exhaustion.
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        // Retain terminal jobs briefly (the status surface reads the DB control row, but this aids ops triage).
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: false,
      },
    });
  }
  return queue;
}

/**
 * Enqueue the DRIVE job for a CONFIRMED bulk-enrich run; the worker chunks it + fans out the chunks. SPEND-SAFE
 * GATE: while the global kill-switch env.BULK_ENRICHMENT_ENABLED is off this enqueues NOTHING and returns null —
 * the pipeline stays dark end-to-end, so no run is ever created (and no worker ever spends) while the feature is
 * off. The gate is enforced here IN the producer (defense in depth) as well as at the caller. Returns the BullMQ
 * job id when enqueued, or null when the feature is off.
 */
export async function enqueueBulkEnrichmentDrive(
  data: BulkEnrichmentDriveJobData,
): Promise<string | null> {
  if (!env.BULK_ENRICHMENT_ENABLED) return null;
  const job = await bulkEnrichmentQueue().add("drive", data);
  return String(job.id);
}
