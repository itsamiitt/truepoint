// gateMemo.ts — short in-process memos for per-tenant GATE reads on hot request paths (perf-audit P2.4).
//
// Once a dual-gated surface's env layer is on, every request paid a full withTenantTx (BEGIN + set_config +
// the lookups + COMMIT) to re-read state that changes during a ROLLOUT or a PLAN CHANGE, not during a
// request: the job-visibility flag on every job-surface read (polled at 10s by every open import page), the
// import-v2 flag on every import request, the channel-read gate on every search/suggest/facet call, and the
// entitlement grants + enforce flag on every metered (money) request. 30 seconds of staleness on any of
// these is invisible; the round trips were not.
//
// IN-PROCESS on purpose (the roleCache Redis precedent was considered and rejected here): the api runs as a
// single process today, the admin writes that change these values land in THIS process and invalidate
// synchronously below, and the short TTL bounds staleness for any future multi-instance deployment. The
// SPEND-RELEASE gates (bulk-enrichment confirm, bulk-import submit) are deliberately NOT memoized — they are
// rare human-clicked actions where a just-revoked flag must hold immediately. Workers read flags per JOB,
// not per request, and keep reading the database.
//
// Failure semantics: a read() that throws is NOT cached — each gate keeps its own fail-open/fail-closed
// posture. Only successful evaluations are memoized.

const TTL_MS = 30_000;

interface Entry<T> {
  value: T;
  expiresAt: number;
}

// ── Flag gates (boolean per tenant + flag key) ─────────────────────────────────────────────────────────────
const flagMemo = new Map<string, Entry<boolean>>();
const flagKeyOf = (tenantId: string, flagKey: string) => `${tenantId}:${flagKey}`;

/** Read a per-tenant gate through the memo. `read` runs only on a miss; its errors propagate uncached. */
export async function flagGateCached(
  tenantId: string,
  flagKey: string,
  read: () => Promise<boolean>,
): Promise<boolean> {
  const k = flagKeyOf(tenantId, flagKey);
  const hit = flagMemo.get(k);
  const now = Date.now();
  if (hit && hit.expiresAt > now) return hit.value;
  const value = await read();
  flagMemo.set(k, { value, expiresAt: now + TTL_MS });
  return value;
}

/** Drop one tenant's memoized value for a flag — called after the admin tenant-override write commits. */
export function invalidateFlagGate(tenantId: string, flagKey: string): void {
  flagMemo.delete(flagKeyOf(tenantId, flagKey));
}

/** Drop EVERY tenant's memoized value for a flag — a global default/definition change affects them all. */
export function invalidateFlagGateKey(flagKey: string): void {
  for (const k of flagMemo.keys()) if (k.endsWith(`:${flagKey}`)) flagMemo.delete(k);
}

/** Drop every memoized flag gate. Used by the GLOBAL flag writes: composed gates (the channel-read port
 *  gate) memoize under a synthetic key that a per-key sweep cannot name, and a global toggle is a rare,
 *  human-clicked admin action — clearing everything is cheaper than being clever and stale. */
export function invalidateAllFlagGates(): void {
  flagMemo.clear();
}

// ── Entitlement basis (grants + enforce flag per tenant; usage is NEVER cached) ──────────────────────────
// The basis changes on plan overrides and flag writes (the enforce switch rides the flag system); usage
// changes on every metered action and must stay live — requireEntitlement reads it per request regardless.
const basisMemo = new Map<string, Entry<unknown>>();

export async function entitlementBasisCached<T>(
  tenantId: string,
  read: () => Promise<T>,
): Promise<T> {
  const hit = basisMemo.get(tenantId);
  const now = Date.now();
  if (hit && hit.expiresAt > now) return hit.value as T;
  const value = await read();
  basisMemo.set(tenantId, { value, expiresAt: now + TTL_MS });
  return value;
}

/** Drop one tenant's entitlement basis — called after a plan override or that tenant's flag write commits. */
export function invalidateEntitlementBasis(tenantId: string): void {
  basisMemo.delete(tenantId);
}

/** Drop every tenant's entitlement basis — a global flag/definition change can move the enforce switch. */
export function invalidateAllEntitlementBasis(): void {
  basisMemo.clear();
}

/** Test seam: reset all gate memos (mirrors resetBreakers in core's waterfall). */
export function resetGateMemos(): void {
  flagMemo.clear();
  basisMemo.clear();
}
