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

/** One tenant's slice of the window — the drill-down table behind the rollup. Mirrors the api
 *  `/admin/billing/economics/by-tenant` payload. Money is integer cents. */
export interface TenantEconomicsRow {
  tenantId: string;
  tenantName: string;
  revenueCents: number;
  creditsSold: number;
  reveals: number;
  chargedReveals: number;
  providerSpendCents: number;
  marginCents: number;
}
