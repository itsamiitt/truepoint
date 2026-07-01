// routes.ts — the PUBLIC, unauthenticated pricing surface (ADR-0012 transparent self-serve). Two reads back
// the public pricing page: the ACTIVE credit-pack catalog and the ACTIVE plan tiers. UNAUTHENTICATED by design
// (no authn/tenancy middleware) — the page must render with no token, no tenant, no balance. The owner-
// connection read goes through withPlatformReadTx (NON-PII catalog ONLY; never tenant data) and projects to
// the public shape (drops the internal `active`/`updatedAt`/Stripe fields). The coarse /api/* IP rate-limit
// (app.ts) is the front-line abuse control. Money is integer cents, USD-authoritative (OD-5).
//
// v1 reads the catalog live on each request (a single bounded, indexed SELECT). A short TTL cache with
// write-time invalidation on credit_pack.set / plan_template.set is the documented follow-up (planning
// api/01-proposed-endpoints §B.4) — deferred so the public read can never serve a stale-forever price.

import { creditPackRepository, planTemplateRepository, withPlatformReadTx } from "@leadwolf/db";
import type { PublicCreditPack, PublicPlan } from "@leadwolf/types";
import { Hono } from "hono";

export const publicPricingRoutes = new Hono();

/** ACTIVE credit packs, projected to the public shape (no internal flags). USD-authoritative (OD-5). */
publicPricingRoutes.get("/credit-packs", async (c) => {
  const rows = await withPlatformReadTx((tx) => creditPackRepository.listActive(tx));
  const packs: PublicCreditPack[] = rows.map((r) => ({
    key: r.key,
    name: r.name,
    credits: r.credits,
    priceCents: r.priceCents,
    currency: "USD",
    sortOrder: r.sortOrder,
  }));
  return c.json({ packs });
});

/** ACTIVE plan tiers, projected to the public shape (entitlement flags + advertised allotment, no internals). */
publicPricingRoutes.get("/plans", async (c) => {
  const rows = await withPlatformReadTx((tx) => planTemplateRepository.listActive(tx));
  const plans: PublicPlan[] = rows.map((r) => ({
    key: r.key,
    name: r.name,
    seatLimit: r.seatLimit,
    workspaceLimit: r.workspaceLimit,
    monthlyCreditGrant: r.monthlyCreditGrant,
    features: r.features,
    sortOrder: r.sortOrder,
  }));
  return c.json({ plans });
});
