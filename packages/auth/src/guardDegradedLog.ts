// guardDegradedLog.ts — a stable, alertable marker for ANY guard that fails open (audit 32 · C11).
//
// Several guards deliberately fail OPEN when Redis is unreachable: the rate limiters (a blip must not lock
// every user out), the entitlement gate, and the revocation deny-list. Each choice is right on its own. The
// problem the audit found is the COMPOSITE: during a Redis outage they open *together*, and on the reveal path
// that leaves credit balance — a Postgres-backed check — as the only remaining control on spend. That is a
// materially different security posture from the one the system claims, and it was reached silently.
//
// This does not change the fail-open behavior (that stays: availability is the right call, and failing closed
// on `revealRateLimit` specifically is flagged for a human decision, not made here). It makes the state
// OBSERVABLE, which is the part that was missing.
//
// ALERT EXPRESSION: `] DEGRADED ` matches every marker — the ones emitted here (`[guard:rate-limit] DEGRADED`)
// and the pre-existing deny-list one (`[revocation] DEGRADED`, revocationLog.ts, whose shape is pinned by its
// own test and deliberately left alone). One expression, one page, and the `guard=`/`op=` field says which
// control opened. Two or more firing inside the same window IS the composite condition.
//
// Kept pure — no env, no Redis, no PII, no I/O — so it is unit-testable and safe to call from a catch block.

/** The guards that deliberately fail open. `revocation` is listed for completeness; it has its own marker. */
export type OpenGuard = "rate-limit" | "reveal-rate-limit" | "entitlement";

/**
 * Format the DEGRADED marker for a guard that just admitted a request it could not check.
 *
 * Carries only the guard name and the error reason — never a key, subject, tenant or identifier, because these
 * fire on the request path during an outage and a log flood is the worst possible place to leak PII.
 */
export function guardDegradedLog(guard: OpenGuard, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  return `[guard:${guard}] DEGRADED dependency unreachable — failing OPEN, request admitted unchecked: ${reason}`;
}

/**
 * A time-based throttle for markers on the per-request path.
 *
 * Without it, a Redis outage turns every request into a log line — which buries the signal it is meant to
 * raise and can cost more than the outage. Returns a predicate that is true at most once per `intervalMs`.
 * `now` is injected rather than read from the clock so the behavior is testable without fake timers.
 */
export function makeDegradedThrottle(intervalMs = 10_000): (now: number) => boolean {
  let last = Number.NEGATIVE_INFINITY;
  return (now: number): boolean => {
    if (now - last < intervalMs) return false;
    last = now;
    return true;
  };
}
