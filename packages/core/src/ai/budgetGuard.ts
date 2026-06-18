// budgetGuard.ts — the per-tenant request budget guard for AI NL-search (23 §7, ADR-0023: per-tenant rate
// limits + budgets, circuit-break on overrun). A daily per-tenant call ceiling protects spend before any
// model is invoked: the guard is checked-and-incremented atomically BEFORE the (paid) model call.
//
// Counting is behind an injectable `AiBudgetStore` so core stays free of infra (16 §5): the app injects a
// process-local in-memory store at this milestone (correct for the inline single-process API — mirrors the
// waterfall's per-process breaker), and a Redis/DB-backed store swaps in behind the same interface for
// horizontal scale, with NO change to this guard or its callers. Tests inject a mock.

/** Atomic "count one request for this tenant on this UTC day, return the new total" store. */
export interface AiBudgetStore {
  /** Increment today's counter for the tenant and return the post-increment count. */
  increment(tenantId: string, day: string): Promise<number>;
  /** Give one reserved unit back (never below zero) — used to refund a reservation when the call fails. */
  decrement(tenantId: string, day: string): Promise<void>;
  /** Read today's counter without incrementing (for surfacing remaining budget; optional path). */
  peek(tenantId: string, day: string): Promise<number>;
}

/** Raised when a tenant has exhausted its daily AI NL-search budget. App maps this to HTTP 429. */
export class AiBudgetExceededError extends Error {
  readonly tenantId: string;
  readonly limit: number;
  constructor(tenantId: string, limit: number) {
    super(`Daily AI search budget reached (${limit}). Try again tomorrow or contact your admin.`);
    this.name = "AiBudgetExceededError";
    this.tenantId = tenantId;
    this.limit = limit;
  }
}

/** UTC day key (YYYY-MM-DD) — the budget window. UTC so the reset is deterministic across regions. */
export function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Reserve one unit of this tenant's daily budget. Increments first, then checks — so concurrent callers can
 * never both slip past the ceiling (the store's increment is the atomicity boundary). Throws
 * AiBudgetExceededError when the post-increment count exceeds `limit` (the over-limit increment is rolled
 * back so a rejected attempt doesn't leave a phantom unit counted). Call this BEFORE the model request.
 */
export async function reserveAiBudget(
  store: AiBudgetStore,
  tenantId: string,
  limit: number,
  now: Date = new Date(),
): Promise<void> {
  const day = utcDayKey(now);
  const used = await store.increment(tenantId, day);
  if (used > limit) {
    await store.decrement(tenantId, day); // don't count the call we're rejecting
    throw new AiBudgetExceededError(tenantId, limit);
  }
}

/**
 * Refund one previously-reserved unit (best-effort) — call this when the model call FAILED, so a transient
 * provider outage doesn't permanently burn the tenant's daily quota. Only successful compilations should
 * consume budget. Idempotent at the store level (decrement never goes below zero).
 */
export async function releaseAiBudget(
  store: AiBudgetStore,
  tenantId: string,
  now: Date = new Date(),
): Promise<void> {
  await store.decrement(tenantId, utcDayKey(now));
}

/**
 * A process-local in-memory AiBudgetStore (the dev/single-process default, like the waterfall's per-process
 * breaker, 18 §9). Keyed by `${tenantId}:${day}`; stale days are pruned lazily on access so the map can't
 * grow without bound. NOT shared across processes — swap a Redis-backed store in for multi-instance scale.
 */
export function createInMemoryBudgetStore(): AiBudgetStore {
  const counts = new Map<string, number>();
  const keyFor = (tenantId: string, day: string) => `${tenantId}:${day}`;

  const pruneOtherDays = (day: string) => {
    const suffix = `:${day}`;
    for (const k of counts.keys()) if (!k.endsWith(suffix)) counts.delete(k);
  };

  return {
    async increment(tenantId, day) {
      pruneOtherDays(day);
      const key = keyFor(tenantId, day);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    async decrement(tenantId, day) {
      const key = keyFor(tenantId, day);
      const next = Math.max(0, (counts.get(key) ?? 0) - 1);
      counts.set(key, next);
    },
    async peek(tenantId, day) {
      return counts.get(keyFor(tenantId, day)) ?? 0;
    },
  };
}
