// revocationLog.ts — a stable, alertable marker for a deny-list DEGRADED event. AUTH-066: the access-token
// revocation deny-list (revocation.ts) fails OPEN when Redis is unreachable — a Redis blip must never 401
// every authenticated request — but it did so SILENTLY. A deny-list outage therefore widened the
// token-revocation window from "immediate" back to the full ≤15-min access-token expiry with NO operator
// signal, so logout / force-revoke / SCIM deprovision could quietly stop taking effect promptly. This emits a
// greppable marker an alert can key on ("[revocation] DEGRADED"). Kept pure (no env, no Redis, no PII) so it
// is unit-testable and safe to call from a catch block.

export type DenyListOp = "mark" | "check";

/**
 * Format the DEGRADED marker for a failed deny-list operation. `mark` = a revocation failed to RECORD (the
 * session is still revoked in the durable store, but its live access token may survive to natural expiry);
 * `check` = a per-request revocation LOOKUP failed and the token was admitted fail-open. Carries no session id
 * or PII — only the operation and the error reason.
 */
export function denyListDegradedLog(op: DenyListOp, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  return `[revocation] DEGRADED op=${op} deny-list unreachable — failing OPEN, token revocation delayed to natural expiry: ${reason}`;
}
