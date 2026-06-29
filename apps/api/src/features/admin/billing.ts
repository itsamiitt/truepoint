// billing.ts — platform-admin billing / revenue-ops endpoints (13a Area 4, 13 §3.4, 07 §9). Mounted under
// /api/v1/admin/billing, so the parent router already applied authn + platformAdmin. Billing oversight is the
// finance team's surface → super_admin OR billing_ops. The economics read runs through the audited
// withPlatformTx (cross-tenant owner read) and returns aggregates only — never per-tenant PII or row dumps.

import { platformBillingReadRepository, withPlatformTx } from "@leadwolf/db";
import { type EconomicsSummary, ValidationError, economicsQuerySchema } from "@leadwolf/types";
import { type Context, Hono } from "hono";
import type { ApiVariables } from "../../middleware/authn.ts";
import { requireCapability } from "../../middleware/requireCapability.ts";

export const billingRoutes = new Hono<{ Variables: ApiVariables }>();

// billing:read = super_admin + billing_ops (13a F3 — capability gate, not a hard-coded role list).
billingRoutes.use("*", requireCapability("billing:read"));

const actorOf = (c: Context<{ Variables: ApiVariables }>) => ({
  userId: c.get("claims").sub,
  ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
});

/** Credit economics over a trailing window: gross credits sold vs consumed, revenue vs metered provider spend,
 *  cost-per-reveal, and margin (07 §9). cost_micros → cents is /10_000 (matches the provider-config rollup). */
billingRoutes.get("/economics", async (c) => {
  const parsed = economicsQuerySchema.safeParse({ sinceDays: c.req.query("sinceDays") });
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const { sinceDays } = parsed.data;
  const since = new Date(Date.now() - sinceDays * 86_400_000);

  const agg = await withPlatformTx(actorOf(c), "admin.billing_economics", (tx) =>
    platformBillingReadRepository.economicsSummary(tx, since),
  );

  const providerSpendCents = Math.round(agg.providerSpendMicros / 10_000);
  const costPerRevealCents =
    agg.chargedReveals > 0
      ? Math.round((agg.providerSpendMicros / 10_000 / agg.chargedReveals) * 100) / 100
      : 0;

  const summary: EconomicsSummary = {
    sinceDays,
    creditsSold: agg.creditsSold,
    revenueCents: agg.revenueCents,
    refundedCents: agg.refundedCents,
    creditsConsumed: agg.creditsConsumed,
    reveals: agg.reveals,
    chargedReveals: agg.chargedReveals,
    providerSpendCents,
    costPerRevealCents,
    marginCents: agg.revenueCents - providerSpendCents,
  };
  return c.json({ summary });
});
