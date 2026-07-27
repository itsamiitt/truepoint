// routes.ts — the PUBLIC, unauthenticated pricing surface (ADR-0012 transparent self-serve). Two reads back
// the public pricing page: the ACTIVE credit-pack catalog and the ACTIVE plan tiers. UNAUTHENTICATED by design
// (no authn/tenancy middleware) — the page must render with no token, no tenant, no balance. The owner-
// connection read goes through withPlatformReadTx (NON-PII catalog ONLY; never tenant data) and projects to
// the public shape (drops the internal `active`/`updatedAt`/Stripe fields). The coarse /api/* IP rate-limit
// (app.ts) is the front-line abuse control. Money is integer cents, USD-authoritative (OD-5).
//
// The documented follow-up is now wired (C-3.1): a SHORT-TTL read-through cache plus explicit invalidation on
// credit_pack.set / plan_template.set, which is what the "never serve a stale-forever price" concern required.
// Both halves are load-bearing — the TTL bounds the damage if an invalidation is ever missed (a Redis blip
// during the admin write), and the invalidation means the normal case is not stale at all.
//
// This is display data, not a money DECISION: checkout re-reads the authoritative row, so the cache can never
// cause a charge at a price the catalog no longer holds. That distinction is why this surface is cacheable at
// all while credit balances and permissions are not.
//
// It is also the one place using `systemKey` rather than `tenantKey`: the public catalog is genuinely
// tenant-less (it must render with no token and no tenant), so there is no tenant dimension to key on.

import { creditPackRepository, planTemplateRepository, withPlatformReadTx } from "@leadwolf/db";
import type { PublicCreditPack, PublicPlan } from "@leadwolf/types";
import { Hono } from "hono";
import { PRICING_PACKS_KEY, PRICING_PLANS_KEY, cache } from "../../cache.ts";

export const publicPricingRoutes = new Hono();

/** Short enough that a missed invalidation self-heals within a minute; long enough to absorb the traffic an
 *  unauthenticated marketing page attracts, which is exactly the traffic that had no cache in front of it. */
const PRICING_TTL_SECONDS = 60;

/** Anonymous responses are identical for every caller, so let the edge hold them briefly too — this route had
 *  no `Cache-Control` at all, so every visitor reached Bun and then Postgres. */
const PUBLIC_CACHE_CONTROL = `public, max-age=${PRICING_TTL_SECONDS}, stale-while-revalidate=30`;

/** ACTIVE credit packs, projected to the public shape (no internal flags). USD-authoritative (OD-5). */
publicPricingRoutes.get("/credit-packs", async (c) => {
  const packs = await cache().getOrSet<PublicCreditPack[]>(
    PRICING_PACKS_KEY,
    PRICING_TTL_SECONDS,
    async () => {
      const rows = await withPlatformReadTx((tx) => creditPackRepository.listActive(tx));
      return rows.map((r) => ({
        key: r.key,
        name: r.name,
        credits: r.credits,
        priceCents: r.priceCents,
        currency: "USD" as const,
        sortOrder: r.sortOrder,
      }));
    },
  );
  c.header("Cache-Control", PUBLIC_CACHE_CONTROL);
  return c.json({ packs });
});

/** ACTIVE plan tiers, projected to the public shape (entitlement flags + advertised allotment, no internals). */
publicPricingRoutes.get("/plans", async (c) => {
  const plans = await cache().getOrSet<PublicPlan[]>(
    PRICING_PLANS_KEY,
    PRICING_TTL_SECONDS,
    async () => {
      const rows = await withPlatformReadTx((tx) => planTemplateRepository.listActive(tx));
      return rows.map((r) => ({
        key: r.key,
        name: r.name,
        seatLimit: r.seatLimit,
        workspaceLimit: r.workspaceLimit,
        monthlyCreditGrant: r.monthlyCreditGrant,
        features: r.features,
        sortOrder: r.sortOrder,
      }));
    },
  );
  c.header("Cache-Control", PUBLIC_CACHE_CONTROL);
  return c.json({ plans });
});
