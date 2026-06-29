// reliability.ts — PURE, IO-free CRM reliability helpers (crm-sync §8.2). No Date.now / Math.random
// lives INSIDE these functions: every nondeterministic input (the jitter, the day-bucket usage, the
// provider Retry-After) is INJECTED, so the helpers unit-test deterministically and converge on replay.
// core owns the decisions; the worker (deferred) supplies the real clock/jitter + the Redis budget store.

import type { CrmOutcome } from "./port.ts";

/** The non-ok CrmOutcome discriminants — the error taxonomy the runner branches on (port.ts). */
export type CrmRetryClass = Exclude<CrmOutcome<unknown>, { kind: "ok" }>["kind"];

/** How the worker must handle a failed connector call. */
export type RetryAction = "retry" | "backoff" | "dlq" | "refresh_auth" | "drop";

/**
 * Map a non-ok CrmOutcome class onto its handling (§8.2 / §5.1). transient → retry w/ backoff;
 * rate_limited → backoff (a 429 is backpressure, NOT a failed attempt); auth_expired → one refresh+retry;
 * not_found → drop (the record is gone — nothing to do); validation/permanent → DLQ (un-retryable);
 * conflict → DLQ for manual review; auth_revoked → DLQ (the connection needs an operator reconnect).
 */
export function classifyRetry(cls: CrmRetryClass): RetryAction {
  switch (cls) {
    case "transient":
      return "retry";
    case "rate_limited":
      return "backoff";
    case "auth_expired":
      return "refresh_auth";
    case "not_found":
      return "drop";
    case "validation":
    case "permanent":
    case "conflict":
    case "auth_revoked":
      return "dlq";
  }
}

/** Backoff tuning. `jitter` is INJECTED (default identity) so the pure fn never calls Math.random itself. */
export interface BackoffOpts {
  baseMs?: number;
  capMs?: number;
  /** The worker passes a real jitter at call time (e.g. full-jitter in [0, d]); default is identity. */
  jitter?: (delayMs: number) => number;
}

/**
 * Deterministic capped exponential backoff: base · 2^attempt, clamped to capMs, then the injected jitter.
 * attempt is clamped to ≥0 and truncated. Defaults: base 1s, cap 5m. PURE — no clock, no RNG inside.
 */
export function backoffDelayMs(attempt: number, opts: BackoffOpts = {}): number {
  const base = opts.baseMs ?? 1_000;
  const cap = opts.capMs ?? 300_000;
  const jitter = opts.jitter ?? ((d) => d);
  const safeAttempt = Math.max(0, Math.trunc(attempt));
  const exp = base * 2 ** safeAttempt;
  const capped = Math.min(exp, cap);
  return Math.max(0, Math.round(jitter(capped)));
}

/** Inputs to the per-connection daily fair-share gate (§8.2 layer 2). All counts are for one UTC day. */
export interface RateBudgetInput {
  /** Provider-authoritative remaining/max daily cap for THIS connection. Missing/0 → fail CLOSED. */
  dailyCap?: number;
  /** Reserved-or-spent calls so far today (the reserve-then-spend counter). */
  usedToday: number;
  /** Good-neighbor fraction of the cap this connection may consume (default tuning ~0.5). */
  fraction: number;
  /** An explicit provider Retry-After (a reactive 429), in ms — always honored first. */
  retryAfterMs?: number;
}

/** The gate decision: whether to spend now, how long to defer, and why (for telemetry / the DLQ reason). */
export interface RateBudgetDecision {
  allow: boolean;
  delayMs: number;
  reason: "retry_after" | "under_budget" | "budget_exhausted" | "cap_unknown";
}

/**
 * The per-connection fair-share budget gate (§8.2 layer 2 — FAILS CLOSED). An explicit Retry-After wins
 * (defer by exactly that long). Otherwise an unknown/zero cap BLOCKS (a missing cap must never read as
 * "infinite headroom" — that is how a shared customer cap gets blown). Under fraction·cap → allow.
 */
export function rateBudgetDecision(input: RateBudgetInput): RateBudgetDecision {
  if (input.retryAfterMs !== undefined && input.retryAfterMs > 0) {
    return { allow: false, delayMs: input.retryAfterMs, reason: "retry_after" };
  }
  if (input.dailyCap === undefined || input.dailyCap <= 0) {
    return { allow: false, delayMs: 0, reason: "cap_unknown" };
  }
  const budget = Math.floor(input.dailyCap * input.fraction);
  if (input.usedToday < budget) {
    return { allow: true, delayMs: 0, reason: "under_budget" };
  }
  return { allow: false, delayMs: 0, reason: "budget_exhausted" };
}
