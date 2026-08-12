// enrichmentQueue.ts — apps/api's BullMQ PRODUCER for the async-first enrich POST (waterfall v2 / 0109,
// ENRICHMENT_ASYNC_ENABLED). The request-side sibling of the worker's enqueueEnrichment: the route
// enqueues and 202s instead of running providers on the request thread (the data-skill mandate:
// "enrichment never runs inside a request"). Producer and consumer are decoupled by BullMQ — they share
// ONLY the queue NAME + job-data contract (@leadwolf/types) and the Redis URL, never each other's code,
// so the apps-never-import-apps boundary holds (16 §5). Lazily opened on first use so merely mounting
// the enrichment router never dials Redis (the home/reverificationQueue.ts precedent).

import { env } from "@leadwolf/config";
import { ENRICHMENT_QUEUE, type EnrichmentJobData } from "@leadwolf/types";
import type { Queue } from "bullmq";
import IORedis from "ioredis";
import { tracedQueue } from "../../lib/tracedQueue.ts";

let queue: Queue<EnrichmentJobData> | undefined;
function enrichmentQueue(): Queue<EnrichmentJobData> {
  if (!queue) {
    const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = tracedQueue<EnrichmentJobData>(ENRICHMENT_QUEUE, {
      connection,
      defaultJobOptions: {
        // MIRRORS the worker's ENRICHMENT_RETRY (apps/workers/src/retryPolicies.ts) so on-demand and
        // worker-enqueued jobs behave identically. A deliberate copy — the two apps may not import each
        // other; if either side changes, change both (the tracedQueue twin-file convention).
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000, jitter: 0.5 },
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: false,
      },
    });
  }
  return queue;
}

/** Enqueue an on-demand single-contact enrichment; the worker runs the same core enrichContact. */
export async function enqueueEnrichmentJob(data: EnrichmentJobData): Promise<string> {
  const job = await enrichmentQueue().add("enrich", data);
  return String(job.id);
}
