// retryPolicies.ts — per-queue retry budgets for the event-queue producers (worker-platform plan 15 §2.2,
// item 0.1). Before this module, six producers enqueued with NO job options, so BullMQ defaulted to a single
// attempt: one transient blip (vendor 503, DB failover, Redis hiccup) permanently lost the job. Every policy
// here is exponential WITH JITTER — without jitter, every job failed by one shared outage retries in lockstep
// and re-hammers the recovering dependency (bullmq ≥5.34 native `jitter`; locked 5.78.0). Pure data with no
// env/Redis import so it is unit-testable (register.ts parses the whole app env at module load).

import type { JobsOptions } from "bullmq";

/** The retry-relevant slice of BullMQ job options a producer spreads into `.add()`. */
export type RetryPolicy = Pick<JobsOptions, "attempts" | "backoff">;

/** De-correlate retries: each retry delay is randomized within ±50% of the exponential step. */
const JITTER = 0.5;

/** On-demand single-contact enrichment: vendor-bound; enrichContact is cache-aware so a retry that finds the
 *  first attempt actually landed does not re-pay the provider. */
export const ENRICHMENT_RETRY: RetryPolicy = {
  attempts: 3,
  backoff: { type: "exponential", delay: 30_000, jitter: JITTER },
};

/** Re-score: cheap, DB-bound, idempotent (appends a versioned scores row; trigger syncs the projection). */
export const SCORING_RETRY: RetryPolicy = {
  attempts: 3,
  backoff: { type: "exponential", delay: 10_000, jitter: JITTER },
};

/** DSAR access/delete fan-out: compliance-critical — a lost job is a missed statutory deadline, so it gets the
 *  largest budget. Deletes are naturally idempotent (re-deleting already-deleted rows is a no-op). */
export const DSAR_RETRY: RetryPolicy = {
  attempts: 5,
  backoff: { type: "exponential", delay: 60_000, jitter: JITTER },
};

/** Outreach step delivery: attempts is 2 — NOT 3 — deliberately. sendStep recomputes the step from the
 *  uncommitted log row, so a crash in the narrow window between the provider send and the tx commit means a
 *  retry RE-SENDS the same step (dispatchOutreachSend.ts documents the double-send hazard verbatim). One retry
 *  covers the dominant failure class (identity/quota/suppression/DB — all pre-send, fully rolled back, quota
 *  refunded) while bounding the worst case to a single duplicate email. Raise only after the send path gains a
 *  per-(logId, step) send-idempotency guard. Throttle deferrals re-enqueue and never burn this budget. */
export const OUTREACH_RETRY: RetryPolicy = {
  attempts: 2,
  backoff: { type: "exponential", delay: 60_000, jitter: JITTER },
};

/** Per-workspace dedup pass: idempotent by design (re-run is always safe — dedup.ts header). */
export const DEDUP_RETRY: RetryPolicy = {
  attempts: 3,
  backoff: { type: "exponential", delay: 15_000, jitter: JITTER },
};

/** Per-workspace firmographics rollup: idempotent by design (re-run is always safe). */
export const FIRMOGRAPHICS_RETRY: RetryPolicy = {
  attempts: 3,
  backoff: { type: "exponential", delay: 15_000, jitter: JITTER },
};

/** Per-workspace freshness re-verification (moved from an inline literal in register.ts; + jitter).
 *  Idempotent — only still-stale rows are touched each pass. */
export const REVERIFICATION_RETRY: RetryPolicy = {
  attempts: 3,
  backoff: { type: "exponential", delay: 60_000, jitter: JITTER },
};

/** Per-workspace master-link backfill (moved from an inline literal in register.ts; + jitter). Self-heal:
 *  the processor throws on errored>0 so BullMQ re-scans; only still-NULL rows are re-resolved (idempotent). */
export const MASTER_BACKFILL_RETRY: RetryPolicy = {
  attempts: 4,
  backoff: { type: "exponential", delay: 30_000, jitter: JITTER },
};

/** Every policy, keyed by queue name — the unit test iterates this so a new policy cannot ship un-asserted. */
export const ALL_RETRY_POLICIES: Readonly<Record<string, RetryPolicy>> = {
  enrichment: ENRICHMENT_RETRY,
  scoring: SCORING_RETRY,
  dsar: DSAR_RETRY,
  outreach: OUTREACH_RETRY,
  dedup: DEDUP_RETRY,
  firmographics: FIRMOGRAPHICS_RETRY,
  reverification: REVERIFICATION_RETRY,
  "master-backfill": MASTER_BACKFILL_RETRY,
};
