// pricing.ts — PUBLIC, customer-facing pricing + plan contracts (ADR-0012 transparent self-serve). Two
// surfaces read these: the UNAUTHENTICATED public pricing page (`GET /api/v1/pricing/*`) and the authenticated
// billing hub plan envelope (`GET /api/v1/credits/me`). Deliberately distinct from pricingAdmin.ts /
// planTemplateAdmin.ts (the staff catalog-CRUD contracts): the public surface exposes ONLY active, non-sensitive
// catalog fields — never a Stripe id, an internal flag, or per-tenant data. USD is authoritative (OD-5) until
// international GTM. The dormant `monthlyCreditGrant` is surfaced as the advertised included allotment; a
// recurring grant is NOT delivered yet (no monthly-grant job), so the page renders it as "included", not "/mo".

import { z } from "zod";

/** A purchasable credit pack as shown on the public pricing page (ACTIVE packs only). Money is integer cents,
 *  USD-authoritative (OD-5). Mirrors the active slice of `credit_packs` with the internal `active` flag dropped. */
export const publicCreditPackSchema = z.object({
  key: z.string(),
  name: z.string(),
  credits: z.number().int(),
  priceCents: z.number().int(),
  currency: z.literal("USD"), // OD-5: USD authoritative until international GTM
  sortOrder: z.number().int(),
});
export type PublicCreditPack = z.infer<typeof publicCreditPackSchema>;

/** A plan tier as shown on the public pricing page (ACTIVE templates only). `features` is the plan's
 *  entitlement-flag map; `monthlyCreditGrant` is the advertised included allotment (null = none). */
export const publicPlanSchema = z.object({
  key: z.string(),
  name: z.string(),
  seatLimit: z.number().int(),
  workspaceLimit: z.number().int().nullable(), // null = unlimited
  monthlyCreditGrant: z.number().int().nullable(), // null = none (dormant: no recurring grant job yet)
  features: z.record(z.boolean()),
  sortOrder: z.number().int(),
});
export type PublicPlan = z.infer<typeof publicPlanSchema>;

/** Response envelope for `GET /api/v1/pricing/credit-packs`. */
export const publicCreditPacksResponseSchema = z.object({ packs: z.array(publicCreditPackSchema) });
export type PublicCreditPacksResponse = z.infer<typeof publicCreditPacksResponseSchema>;

/** Response envelope for `GET /api/v1/pricing/plans`. */
export const publicPlansResponseSchema = z.object({ plans: z.array(publicPlanSchema) });

/** POST /credits/checkout body — the credit pack the customer wants to buy, by its catalog key (M11, ADR-0041). */
export const creditCheckoutSchema = z.object({
  pack: z.string().min(1).max(100),
});
export type CreditCheckout = z.infer<typeof creditCheckoutSchema>;

/** POST /credits/subscribe body — the plan the customer wants to subscribe to, by its template key (M11 subs). */
export const subscribeSchema = z.object({
  plan: z.string().min(1).max(100),
});
export type Subscribe = z.infer<typeof subscribeSchema>;

/** GET /credits/subscription — the tenant's current subscription for the billing hub, or null (month-to-month).
 *  Read-only mirror of Stripe state (M11 subs, ADR-0041). */
export const subscriptionViewSchema = z.object({
  plan: z.string(),
  planName: z.string().nullable(),
  status: z.string(),
  term: z.string(),
  currentPeriodEnd: z.string().nullable(), // ISO-8601
  cancelAtPeriodEnd: z.boolean(),
  autoRenew: z.boolean(),
});
export type SubscriptionView = z.infer<typeof subscriptionViewSchema>;

/** One entry in the customer's own credit history (M11, ADR-0029) — a signed movement + the running balance
 *  after it. `entryType` is grant | spend | credit_back | adjustment (+ subscription reset/expiry). */
export const creditLedgerEntrySchema = z.object({
  id: z.string().uuid(),
  entryType: z.string(),
  delta: z.number().int(),
  balanceAfter: z.number().int().nullable(),
  reason: z.string().nullable(),
  createdAt: z.string(), // ISO-8601
});
export type CreditLedgerEntry = z.infer<typeof creditLedgerEntrySchema>;
export type PublicPlansResponse = z.infer<typeof publicPlansResponseSchema>;

/** The authenticated tenant's plan + credits envelope — `GET /api/v1/credits/me`. Reads the tenant counter and
 *  entitlement columns plus live seat/workspace usage (no migration). Replaces the web billing page's
 *  null-tolerant plan tiles. `planName` resolves the denormalized `plan` key against the active template
 *  catalog, or null when the key has no active template. */
export const tenantPlanEnvelopeSchema = z.object({
  plan: z.string(), // tenants.plan = plan_templates.key (denormalized, no FK)
  planName: z.string().nullable(), // resolved template name (incl. grandfathered/retired), or null
  seatLimit: z.number().int(),
  seatsUsed: z.number().int(),
  workspaceLimit: z.number().int().nullable(), // null = unlimited
  workspacesUsed: z.number().int(),
  revealCreditBalance: z.number().int(),
  features: z.record(z.boolean()),
});
export type TenantPlanEnvelope = z.infer<typeof tenantPlanEnvelopeSchema>;
