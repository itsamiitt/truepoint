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
const DEFAULT_MAX_DEFERRALS = 3;
/** Above this vendor-suggested delay the job PARKS instead of deferring (env ENRICH_DEFER_MAX_DELAY_MS
 *  at the composition root): the ledger's rate_limited rows + the breaker horizon carry the state, and a
 *  daily-budget 86400s Retry-After never piles up day-long delayed jobs in Redis. */
const DEFAULT_MAX_DEFER_DELAY_MS = 1_800_000;
/** Deferral jitter spreads UP (base..1.5×base): retrying EARLIER than Retry-After re-hits the throttle,
 *  and an unjittered fleet retries in lockstep (the exact herd retryPolicies.ts jitters against). */
const defaultDeferJitter = (ms: number): number => Math.round(ms * (1 + 0.5 * Math.random()));

export interface EnrichmentProcessorDeps {
  /** Redis-shared breaker/gate (+ verifier overrides in tests) for the v2 path. */
  enrich?: EnrichDeps;
  /** Re-enqueue this job's data after a throttle deferral. Absent ⇒ no deferral (result returned as-is). */
  defer?: (data: EnrichmentJobData, delayMs: number) => Promise<void>;
  /** Deferral cap per original job (env ENRICH_MAX_DEFERRALS). Default 3. */
  maxDeferrals?: number;
  /** Park threshold (env ENRICH_DEFER_MAX_DELAY_MS). Default 30 min. */
  maxDeferDelayMs?: number;
  /** Injected for deterministic tests; default spreads the delay up by 0–50%. */
  jitter?: (ms: number) => number;
  /** Test seam: the core waterfall entry. Default the real enrichContact — no module mocks (bun's
   *  mock.module is process-global; the global-state hazard this repo has been bitten by). */
  enrichContactFn?: typeof enrichContact;
}

export function makeProcessEnrichment(deps: EnrichmentProcessorDeps = {}) {
  return async function processEnrichment(
    job: Job<EnrichmentJobData>,
  ): Promise<EnrichContactResult> {
    const { tenantId, workspaceId, contactId, fields, requestedByUserId, providerOrder } = job.data;
    let result: EnrichContactResult;
    try {
      result = await (deps.enrichContactFn ?? enrichContact)(
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
    // v2 deferral: throttling filled nothing — try again after the smallest vendor-suggested delay,
    // JITTERED UP so a fleet throttled by one vendor doesn't retry in lockstep. Deferred, never dropped;
    // the re-enqueued job re-reads the cache first, so a concurrent fill costs nothing. CAPPED at
    // maxDeferrals so a permanently throttled vendor set can't turn one request into an infinite
    // re-enqueue cycle, and PARKED (no re-enqueue at all) when the vendor's horizon exceeds
    // maxDeferDelayMs — a daily-budget wait is structural, not schedulable; the `unfilled` result
    // stands, and the ledger's rate_limited rows + the breaker horizon say why.
    const deferrals = job.data.deferrals ?? 0;
    const suggestedDelayMs = result.retryAfterMs ?? DEFAULT_DEFER_MS;
    if (
      result.status === "unfilled" &&
      result.allThrottled &&
      deps.defer &&
      deferrals < (deps.maxDeferrals ?? DEFAULT_MAX_DEFERRALS) &&
      suggestedDelayMs <= (deps.maxDeferDelayMs ?? DEFAULT_MAX_DEFER_DELAY_MS)
    ) {
      await deps.defer(
        { ...job.data, deferrals: deferrals + 1 },
        (deps.jitter ?? defaultDeferJitter)(suggestedDelayMs),
      );
    }
    return result;
  };
}

/** The dependency-free processor (legacy/in-process defaults) — kept for compatibility with existing tests. */
export const processEnrichment = makeProcessEnrichment();
