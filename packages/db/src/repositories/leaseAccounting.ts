// leaseAccounting.ts — the PURE money math for the ADR-0029 reserve-then-settle bulk-reveal lease (kept in its
// own side-effect-free module so it unit-tests without the DB client). Given a job's lease (total reserved +
// the subscription portion) and what it ACTUALLY spent, compute how much to return to the tenant counter
// (`remainder = leased − spent`) and how much of that goes back to the perishable subscription bucket (spend is
// attributed subscription-first, so the unspent subscription portion is restored). This keeps 0 ≤ sub ≤ total
// after release and makes lease(−ceiling) + release(+remainder) net to exactly −spent on the counter, so the
// billing-recon invariant (balance == SUM(ledger delta)) holds.

export function computeReleaseSplit(
  leased: number,
  leasedFromSubscription: number,
  spent: number,
): { remainder: number; subRestore: number } {
  const l = Math.max(0, Math.trunc(leased));
  const s = Math.max(0, Math.min(l, Math.trunc(spent)));
  const remainder = l - s;
  if (remainder <= 0) return { remainder: 0, subRestore: 0 };
  const leasedFromSub = Math.max(0, Math.min(l, Math.trunc(leasedFromSubscription)));
  const spentFromSub = Math.min(s, leasedFromSub);
  return { remainder, subRestore: leasedFromSub - spentFromSub };
}
