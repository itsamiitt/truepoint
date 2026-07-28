// crmBudgetGuard.ts — the PROACTIVE per-connection API budget (crm-sync 00 §2.2 gap 4 / §8.2).
//
// Before this, the only protection was reactive: wait for a 429, then back off. That is too late twice over
// — the provider has already counted the call against the customer's org quota, and a runaway sync (a bad
// mapping, a reconcile loop, a retry storm) can burn a whole day's allowance before anything reacts. This
// guard refuses the call FIRST.
//
// TWO INVERSIONS OF THE REPO'S EXISTING DEFAULTS, both called for by §8, both deliberate:
//
//  1. THE STORE IS REDIS-BACKED, NOT PROCESS-LOCAL. The AI budget guard's in-memory store is correct for a
//     single inline API process; a CRM budget is not. Workers are horizontally scaled, so a per-process
//     counter means N workers each grant the full budget and the real ceiling is N× what the operator set.
//     The store is injected (core stays infra-free) but the contract is explicitly "shared across
//     processes" — a process-local implementation would be a bug, not a simplification.
//
//  2. IT FAILS CLOSED. packages/auth's rate limiter fails OPEN on a Redis outage, which is right for a
//     login path: locking every user out because Redis blinked is worse than briefly unlimited attempts.
//     Here the trade runs the other way. Failing open means an unbounded outbound sync against a
//     third-party API we do not own, spending a CUSTOMER's quota — and the cost of failing closed is a
//     delayed sync that catches up on the next tick. A sync being late is recoverable; a burned daily quota
//     locks the customer out of their own CRM for the rest of the day.
//
// The budget is per CONNECTION, not per tenant: the quota being protected belongs to the CRM org, and one
// workspace may hold a Salesforce and a HubSpot connection with entirely independent allowances.

/**
 * Atomic "count N calls against this connection in this window" store. MUST be shared across processes —
 * see inversion (1). Implementations live in @leadwolf/integrations and are injected at the root.
 */
export interface CrmBudgetStore {
  /**
   * Add `cost` to the connection's counter for `window` and return the post-increment total.
   *
   * Throwing is meaningful: the guard treats a store failure as "no budget", per inversion (2). An
   * implementation must therefore NOT swallow its own errors and return 0.
   */
  increment(connectionId: string, window: string, cost: number): Promise<number>;
  /** Give `cost` back (never below zero) — refunds a reservation whose call never happened. */
  decrement(connectionId: string, window: string, cost: number): Promise<void>;
  /** Read without incrementing, for surfacing remaining budget. */
  peek(connectionId: string, window: string): Promise<number>;
}

/** Raised when a connection has spent its allowance for the window. */
export class CrmBudgetExceededError extends Error {
  constructor(
    readonly connectionId: string,
    readonly limit: number,
    readonly used: number,
  ) {
    super(`CRM API budget reached for this connection (${used}/${limit}).`);
    this.name = "CrmBudgetExceededError";
  }
}

/** Raised when the budget could not be established at all. Distinct from "exceeded" — see inversion (2). */
export class CrmBudgetUnavailableError extends Error {
  constructor(readonly connectionId: string) {
    super("CRM API budget could not be checked; refusing the call.");
    this.name = "CrmBudgetUnavailableError";
  }
}

/**
 * The budget window key. UTC hour, not day.
 *
 * Both providers publish rolling limits far shorter than a day (HubSpot per-10-seconds AND daily; Salesforce
 * a 24h org quota). An hourly window is the useful compromise: it bounds a runaway loop to ~1/24th of a
 * daily allowance instead of letting it consume everything before midnight, and it recovers on its own
 * without an operator clearing a counter. UTC so the reset is deterministic across regions.
 */
export function crmBudgetWindow(now: Date = new Date()): string {
  return now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

export interface CrmBudgetDecision {
  allowed: boolean;
  used: number;
  limit: number;
  reason?: "exceeded" | "unavailable";
}

/**
 * Reserve `cost` API calls against a connection's budget. Increment-then-check, so concurrent workers can
 * never both slip past the ceiling — the store's increment is the atomicity boundary.
 *
 * Returns a decision rather than throwing on the exceeded path, because "over budget" is an ordinary
 * operational state a runner reports and re-enqueues from, not an exception. A STORE failure is different:
 * it means we do not know the budget, and per inversion (2) that refuses the call.
 */
export async function reserveCrmBudget(
  store: CrmBudgetStore,
  connectionId: string,
  limit: number,
  cost = 1,
  now: Date = new Date(),
): Promise<CrmBudgetDecision> {
  // A non-positive limit means "no budget configured". Treated as UNLIMITED rather than zero: the guard is
  // opt-in per connection, and defaulting an unconfigured connection to zero would silently stop every
  // sync in the fleet the moment this shipped. The operator opts INTO a cap.
  if (limit <= 0) return { allowed: true, used: 0, limit: 0 };

  const window = crmBudgetWindow(now);
  let used: number;
  try {
    used = await store.increment(connectionId, window, cost);
  } catch {
    // FAIL CLOSED. We cannot establish the budget, so we do not spend the customer's quota on a guess.
    return { allowed: false, used: 0, limit, reason: "unavailable" };
  }

  if (used > limit) {
    // Roll back the increment we are rejecting, so a refused attempt does not permanently inflate the
    // counter and lock the connection out for the rest of the window.
    await store.decrement(connectionId, window, cost).catch(() => {
      /* best-effort: the window expires on its own */
    });
    return { allowed: false, used, limit, reason: "exceeded" };
  }

  return { allowed: true, used, limit };
}

/**
 * Refund a reservation whose call never happened (a gate refused later, a crash before the request).
 *
 * Best-effort and never throws: a failed refund costs the connection a little headroom until the window
 * rolls, which is strictly better than failing the job that was already succeeding.
 */
export async function releaseCrmBudget(
  store: CrmBudgetStore,
  connectionId: string,
  cost = 1,
  now: Date = new Date(),
): Promise<void> {
  await store.decrement(connectionId, crmBudgetWindow(now), cost).catch(() => {
    /* see the doc comment */
  });
}
