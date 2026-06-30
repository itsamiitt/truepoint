// billingAdmin.ts — platform-admin billing/revenue-ops contracts (13a Area 4, 13 §3.4, 07 §9). The credit
// economics rollup the internal team needs: gross credits sold vs consumed, revenue vs metered provider spend,
// cost-per-reveal and margin — aggregated cross-tenant over a window. Read-only; shared by apps/api (validates
// the query) and apps/admin (derives its view type). Money values are integer cents; cost-per-reveal may be
// fractional. Pricing numbers are placeholders (07 §1) — these metrics report what actually happened, not a
// forecast.

import { z } from "zod";

/** The economics window: the trailing N days to aggregate over (bounded). */
export const economicsQuerySchema = z.object({
  sinceDays: z.coerce.number().int().min(1).max(365).default(30),
});
export type EconomicsQuery = z.infer<typeof economicsQuerySchema>;

/** A tenant's credit-pack purchase as shown in the console (no Stripe ids — those are internal). */
export const purchaseViewSchema = z.object({
  id: z.string().uuid(),
  credits: z.number().int(),
  amountCents: z.number().int().nullable(),
  status: z.string(), // completed | refunded
  createdAt: z.string(), // ISO-8601
});
export type PurchaseView = z.infer<typeof purchaseViewSchema>;

/** The result of a refund — the credits actually reversed (clamped to the available balance, since the bare
 *  counter cannot go negative; the full reconciliation is the M11 ledger's job) and the new balance. */
export const refundResultSchema = z.object({
  purchaseId: z.string().uuid(),
  reversed: z.number().int(),
  balanceAfter: z.number().int(),
});
export type RefundResult = z.infer<typeof refundResultSchema>;

/** One tenant's slice of the economics window — the per-tenant drill-down behind the rollup (which tenants
 *  actually drive the revenue and the metered provider spend). Money is integer cents; the rest are counts. */
export const tenantEconomicsRowSchema = z.object({
  tenantId: z.string().uuid(),
  tenantName: z.string(),
  revenueCents: z.number().int(), // SUM purchases.amount_cents (completed) for this tenant
  creditsSold: z.number().int(),
  reveals: z.number().int(),
  chargedReveals: z.number().int(),
  providerSpendCents: z.number().int(), // SUM provider_calls.cost_micros / 10_000 for this tenant
  marginCents: z.number().int(), // revenueCents - providerSpendCents
});
export type TenantEconomicsRow = z.infer<typeof tenantEconomicsRowSchema>;

/** Query the low-credit-balance tenant list — the proactive top-up / churn-risk view (07 §9). `threshold` is
 *  the at-or-below credit balance; both bounded. */
export const lowBalanceQuerySchema = z.object({
  threshold: z.coerce.number().int().min(0).max(100_000).default(100),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type LowBalanceQuery = z.infer<typeof lowBalanceQuerySchema>;

/** One active tenant at/under the credit-balance threshold — who to nudge for a top-up before they churn. */
export const lowBalanceTenantSchema = z.object({
  tenantId: z.string().uuid(),
  tenantName: z.string(),
  plan: z.string(),
  revealCreditBalance: z.number().int(),
});
export type LowBalanceTenant = z.infer<typeof lowBalanceTenantSchema>;

/** One tenant's economics detail — the per-tenant drill-down on the tenant-detail console (complements the
 *  cross-tenant rollup). Windowed (`sinceDays`) + lifetime money picture; PII-free. Money is integer cents;
 *  cost-per-reveal may be fractional. `lastPurchaseAt` is the newest completed top-up (ISO), or null. NOTE:
 *  packs-not-subscriptions — there is NO MRR/ARR here (that is decision-gated on OD-1), only realized spend. */
export const tenantEconomicsDetailSchema = z.object({
  tenantId: z.string().uuid(),
  tenantName: z.string(),
  plan: z.string(),
  revealCreditBalance: z.number().int(),
  sinceDays: z.number().int(),
  // window [since, now]
  revenueCents: z.number().int(),
  refundedCents: z.number().int(),
  creditsSold: z.number().int(),
  creditsConsumed: z.number().int(),
  reveals: z.number().int(),
  chargedReveals: z.number().int(),
  providerSpendCents: z.number().int(),
  costPerRevealCents: z.number(), // providerSpendCents / chargedReveals (0 when none)
  marginCents: z.number().int(), // revenueCents - providerSpendCents
  // lifetime (all-time)
  lifetimeRevenueCents: z.number().int(),
  lifetimeRefundedCents: z.number().int(),
  lifetimeCreditsSold: z.number().int(),
  lifetimeCreditsConsumed: z.number().int(),
  lastPurchaseAt: z.string().nullable(), // ISO-8601 or null
});
export type TenantEconomicsDetail = z.infer<typeof tenantEconomicsDetailSchema>;

/** The economics summary for the window (07 §9 "internal reporting"). */
export const economicsSummarySchema = z.object({
  sinceDays: z.number().int(),
  creditsSold: z.number().int(), // SUM purchases.credits (completed)
  revenueCents: z.number().int(), // SUM purchases.amount_cents (completed)
  refundedCents: z.number().int(), // SUM purchases.amount_cents (refunded)
  creditsConsumed: z.number().int(), // SUM contact_reveals.credits_consumed
  reveals: z.number().int(), // COUNT contact_reveals
  chargedReveals: z.number().int(), // COUNT where credits_consumed > 0
  providerSpendCents: z.number().int(), // SUM provider_calls.cost_micros / 10_000
  costPerRevealCents: z.number(), // providerSpendCents / chargedReveals (0 when none)
  marginCents: z.number().int(), // revenueCents - providerSpendCents
});
export type EconomicsSummary = z.infer<typeof economicsSummarySchema>;
