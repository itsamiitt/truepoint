// subscriptionResetMath.ts — the PURE arithmetic of the subscription monthly reset (M11 buckets, ADR-0041),
// split out so it is unit-testable without a database. creditRepository.applyMonthlyReset applies this under the
// tenant row lock (the SQL); this module is just the numbers.

export interface MonthlyResetMath {
  /** The perishable allotment expired (= the old subscription bucket). */
  expired: number;
  /** Total after expiring the old allotment — this is exactly the PURCHASED credits (never touched). */
  afterExpiry: number;
  /** Total after granting the new allotment. */
  afterGrant: number;
  /** The new perishable bucket (= the grant). */
  newSubscription: number;
}

/**
 * total = current reveal_credit_balance, subscription = current perishable bucket, grantCredits = the plan's
 * monthly grant. Expire the old allotment (purchased = total − subscription is left intact), then grant the new
 * one. The two ledger deltas are (−expired) + (+grantCredits); their sum equals the net counter change, so
 * SUM(delta) == counter still holds afterwards (billing-recon stays green).
 */
export function computeMonthlyReset(
  total: number,
  subscription: number,
  grantCredits: number,
): MonthlyResetMath {
  const expired = subscription;
  const afterExpiry = total - expired;
  const afterGrant = afterExpiry + grantCredits;
  return { expired, afterExpiry, afterGrant, newSubscription: grantCredits };
}
