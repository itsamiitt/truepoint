// enrichment.ts — the `enrichment` queue processor (06 §4): injects the configured vendor adapters
// (packages/integrations) into core's enrichContact. Provider I/O lives here on the worker, never on the
// api request thread or inside the reveal lock window.
//
// Waterfall v2 (0109): the processor is a FACTORY (the bulkEnrichment precedent) so the composition root
// can inject the Redis-shared breaker + provider gate. When a v2 run reports all-throttled-nothing-filled,
// the job is DEFERRED — re-enqueued with the vendor-suggested delay — never dropped (the mailboxThrottle
// posture). Legacy path (flag off): deps are unused and behavior is unchanged.

import { type EnrichContactResult, type EnrichDeps, enrichContact } from "@leadwolf/core";
import { defaultProviders } from "@leadwolf/integrations";
import { ENRICHMENT_DLQ, ENRICHMENT_QUEUE, type EnrichmentJobData } from "@leadwolf/types";
import type { Job } from "bullmq";

// Queue + DLQ names AND the job-data contract live in @leadwolf/types (the api's 202 producer shares
// them; reverification precedent) and are RE-EXPORTED here so register.ts keeps importing them from this
// module unchanged.
export { ENRICHMENT_DLQ, ENRICHMENT_QUEUE };
export type { EnrichmentJobData };

const DEFAULT_DEFER_MS = 30_000;

export interface EnrichmentProcessorDeps {
  /** Redis-shared breaker/gate (+ verifier overrides in tests) for the v2 path. */
  enrich?: EnrichDeps;
  /** Re-enqueue this job's data after a throttle deferral. Absent ⇒ no deferral (result returned as-is). */
  defer?: (data: EnrichmentJobData, delayMs: number) => Promise<void>;
}

export function makeProcessEnrichment(deps: EnrichmentProcessorDeps = {}) {
  return async function processEnrichment(
    job: Job<EnrichmentJobData>,
  ): Promise<EnrichContactResult> {
    const { tenantId, workspaceId, contactId, fields, requestedByUserId, providerOrder } = job.data;
    const result = await enrichContact(
      {
        scope: { tenantId, workspaceId },
        contactId,
        fields,
        providers: defaultProviders(),
        requestedByUserId,
        providerOrder,
      },
      deps.enrich,
    );
    // v2 deferral: every capable provider was throttle-denied and nothing was filled — try again after
    // the smallest vendor-suggested delay. Deferred, never dropped; the re-enqueued job re-reads the
    // cache first, so a concurrent fill costs nothing.
    if (result.status === "unfilled" && result.allThrottled && deps.defer) {
      await deps.defer(job.data, result.retryAfterMs ?? DEFAULT_DEFER_MS);
    }
    return result;
  };
}

/** The dependency-free processor (legacy/in-process defaults) — kept for compatibility with existing tests. */
export const processEnrichment = makeProcessEnrichment();
