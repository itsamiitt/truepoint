// enrichment.ts — the `enrichment` queue processor (06 §4): injects the configured vendor adapters
// (packages/integrations) into core's enrichContact. Provider I/O lives here on the worker, never on the
// api request thread or inside the reveal lock window.
//
// Waterfall v2 (0111): the processor is a FACTORY (the bulkEnrichment precedent) so the composition root
// can inject the Redis-shared breaker + provider gate. When a v2 run reports all-throttled-nothing-filled,
// the job is DEFERRED — re-enqueued with the vendor-suggested delay — never dropped (the mailboxThrottle
// posture). Legacy path (flag off): deps are unused and behavior is unchanged.

import { type EnrichContactResult, type EnrichDeps, enrichContact } from "@leadwolf/core";
import { defaultProviders } from "@leadwolf/integrations";
import {
  ENRICHMENT_DLQ,
  ENRICHMENT_QUEUE,
  type EnrichmentJobData,
  NotFoundError,
  ProviderBudgetExceededError,
  ValidationError,
} from "@leadwolf/types";
import { type Job, UnrecoverableError } from "bullmq";

// Queue + DLQ names AND the job-data contract live in @leadwolf/types (the api's 202 producer shares
// them; reverification precedent) and are RE-EXPORTED here so register.ts keeps importing them from this
// module unchanged.
export { ENRICHMENT_DLQ, ENRICHMENT_QUEUE };
export type { EnrichmentJobData };

const DEFAULT_DEFER_MS = 30_000;
/** All-throttled deferrals per original job — bounds the re-enqueue cycle (defer, never drop, never spin). */
const MAX_DEFERRALS = 3;

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
    let result: EnrichContactResult;
    try {
      result = await enrichContact(
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
    } catch (err) {
      // Permanent-failure classification (perf-audit P1.7). These cannot succeed on a 30s/60s backoff
      // retry — the daily budget resets at UTC midnight, a deleted contact stays deleted, a malformed
      // payload stays malformed — so retrying burned the full attempts budget per job for nothing (a
      // budget-exhausted workspace produced 3 doomed vendor-adjacent attempts on EVERY subsequent job
      // until midnight). UnrecoverableError fails the job immediately; the failed-listener still records
      // it to the DLQ, where it is inspectable and replayable once the cause has actually changed.
      if (
        err instanceof ProviderBudgetExceededError ||
        err instanceof NotFoundError ||
        err instanceof ValidationError
      ) {
        throw new UnrecoverableError(`${err.name}: ${err.message}`);
      }
      throw err;
    }
    // v2 deferral: every capable provider was throttle-denied and nothing was filled — try again after
    // the smallest vendor-suggested delay. Deferred, never dropped; the re-enqueued job re-reads the
    // cache first, so a concurrent fill costs nothing. CAPPED at MAX_DEFERRALS so a permanently
    // throttled vendor set can't turn one request into an infinite re-enqueue cycle — the final
    // `unfilled` result stands and the ledger's rate_limited rows say why.
    const deferrals = job.data.deferrals ?? 0;
    if (
      result.status === "unfilled" &&
      result.allThrottled &&
      deps.defer &&
      deferrals < MAX_DEFERRALS
    ) {
      await deps.defer(
        { ...job.data, deferrals: deferrals + 1 },
        result.retryAfterMs ?? DEFAULT_DEFER_MS,
      );
    }
    return result;
  };
}

/** The dependency-free processor (legacy/in-process defaults) — kept for compatibility with existing tests. */
export const processEnrichment = makeProcessEnrichment();
