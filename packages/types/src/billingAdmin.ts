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
