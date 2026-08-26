// backoff.ts — deterministic capped exponential backoff, PURE (no clock, no RNG inside: the jitter is
// INJECTED, default identity). Moved verbatim from crm-sync/reliability.ts so the data-source fetch and
// enrichment lanes share it; crm-sync/reliability.ts re-exports it for its original import sites.

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
