// providerGate.ts — the per-provider rate-limit + monthly-budget PORT for the waterfall (v2 / 0109).
// This is where provider_configs.rate_limit_per_min and monthly_budget_cents — stored since 13 §3.6 but
// never read by the engine — finally get enforced. core owns the port; the Redis implementation lives in
// packages/integrations (redisProviderGate: a mailboxThrottle-style token bucket per provider + a monthly
// spend counter), because BullMQ's limiter is per-QUEUE and cannot bound one vendor among five.
//
// Failure posture (the crmBudgetStore precedent): a gate that cannot be evaluated FAILS CLOSED for that
// provider — the waterfall skips it and cascades on. Skipping one vendor on a Redis blip costs a fallback
// call; letting an unbounded loop through a broken gate costs real money.

export type GateDecision =
  | { allowed: true }
  | { allowed: false; reason: "rate_limited" | "budget"; retryAfterMs?: number };

/** The per-provider limits the gate enforces, read from provider_configs (null = unlimited). Limits are
 *  passed PER CALL (the engine reads them fresh from the tx1 config read) so the gate instance itself is
 *  a long-lived, connection-holding singleton wired once at the composition root. */
export interface ProviderLimits {
  rateLimitPerMin: number | null;
  monthlyBudgetCents: number | null;
}

export interface ProviderGate {
  /** May this provider be called right now, at this estimated cost, under these configured limits? */
  allow(provider: string, estCostMicros: number, limits: ProviderLimits): Promise<GateDecision>;
  /** Fold the ACTUAL cost of a completed call into the budget window (post-run). */
  settle(provider: string, actualCostMicros: number): Promise<void>;
}

/** No limits configured / test default: everything is allowed, nothing is counted. */
export const passThroughGate: ProviderGate = {
  allow: () => Promise.resolve({ allowed: true }),
  settle: () => Promise.resolve(),
};
