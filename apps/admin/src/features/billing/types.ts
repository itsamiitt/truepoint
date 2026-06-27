// types.ts — the shape the Billing economics area renders. Mirrors the api `/admin/billing/economics` payload
// (apps/api/src/features/admin/billing.ts, backed by @leadwolf/db platformBillingReads). Money is integer
// cents; cost-per-reveal may be fractional cents. Presentation-side type only; the api owns the canonical shape.

export interface EconomicsSummary {
  sinceDays: number;
  creditsSold: number;
  revenueCents: number;
  refundedCents: number;
  creditsConsumed: number;
  reveals: number;
  chargedReveals: number;
  providerSpendCents: number;
  costPerRevealCents: number;
  marginCents: number;
}
