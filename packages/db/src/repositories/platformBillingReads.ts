// platformBillingReads.ts — read-only cross-tenant billing/economics aggregation for the platform-admin
// revenue-ops surface (13a Area 4, 07 §9). Runs inside the audited withPlatformTx (owner connection, bypasses
// RLS) so it sees every tenant. Three bounded aggregate queries (purchases, contact_reveals, provider_calls),
// each filtered to the window — SUM/COUNT only, no row dump. Cost is stored in micro-dollars; the api converts
// to cents (cost_micros / 10_000), matching providerConfigRepository.

import { desc, eq, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { purchases } from "../schema/billing.ts";

/** Raw aggregates over the window — the api derives the cents/margin/cost-per-reveal view from these. */
export interface EconomicsAggregate {
  creditsSold: number;
  revenueCents: number;
  refundedCents: number;
  creditsConsumed: number;
  reveals: number;
  chargedReveals: number;
  providerSpendMicros: number;
}

/** Per-tenant slice of the economics window — provider spend stays in micros (the api converts to cents). */
export interface TenantEconomicsAggregate {
  tenantId: string;
  tenantName: string;
  revenueCents: number;
  creditsSold: number;
  reveals: number;
  chargedReveals: number;
  providerSpendMicros: number;
}

/** One credit-pack purchase row (no Stripe ids). */
export interface PlatformPurchaseRow {
  id: string;
  credits: number;
  amountCents: number | null;
  status: string;
  createdAt: Date;
}

export const platformBillingReadRepository = {
  /** Aggregate the money loop over `[since, now]`: purchases (sold/revenue/refunds), reveals (consumed/count),
   *  provider spend. Each is a single grouped scan; the time columns are indexed on their tables. */
  async economicsSummary(tx: Tx, since: Date): Promise<EconomicsAggregate> {
    const iso = since.toISOString();

    const [p] = (await tx.execute(sql`
      SELECT
        coalesce(sum(credits) FILTER (WHERE status = 'completed'), 0)::bigint      AS credits_sold,
        coalesce(sum(amount_cents) FILTER (WHERE status = 'completed'), 0)::bigint AS revenue_cents,
        coalesce(sum(amount_cents) FILTER (WHERE status = 'refunded'), 0)::bigint  AS refunded_cents
      FROM purchases
      WHERE created_at >= ${iso}::timestamptz
    `)) as unknown as Array<{
      credits_sold: number;
      revenue_cents: number;
      refunded_cents: number;
    }>;

    const [r] = (await tx.execute(sql`
      SELECT
        coalesce(sum(credits_consumed), 0)::bigint                AS credits_consumed,
        count(*)::bigint                                          AS reveals,
        (count(*) FILTER (WHERE credits_consumed > 0))::bigint    AS charged_reveals
      FROM contact_reveals
      WHERE revealed_at >= ${iso}::timestamptz
    `)) as unknown as Array<{ credits_consumed: number; reveals: number; charged_reveals: number }>;

    const [s] = (await tx.execute(sql`
      SELECT coalesce(sum(cost_micros), 0)::bigint AS provider_spend_micros
      FROM provider_calls
      WHERE called_at >= ${iso}::timestamptz
    `)) as unknown as Array<{ provider_spend_micros: number }>;

    return {
      creditsSold: Number(p?.credits_sold ?? 0),
      revenueCents: Number(p?.revenue_cents ?? 0),
      refundedCents: Number(p?.refunded_cents ?? 0),
      creditsConsumed: Number(r?.credits_consumed ?? 0),
      reveals: Number(r?.reveals ?? 0),
      chargedReveals: Number(r?.charged_reveals ?? 0),
      providerSpendMicros: Number(s?.provider_spend_micros ?? 0),
    };
  },

  /** The per-tenant drill-down behind economicsSummary: the same three windowed aggregates (purchases,
   *  reveals, provider spend) GROUPED BY tenant and joined to `tenants` for the name, filtered to tenants with
   *  any activity, ordered by provider spend (the cost drivers) then revenue, bounded to `limit`. Owner read. */
  async economicsByTenant(tx: Tx, since: Date, limit: number): Promise<TenantEconomicsAggregate[]> {
    const iso = since.toISOString();
    const rows = (await tx.execute(sql`
      WITH p AS (
        SELECT tenant_id,
          coalesce(sum(credits) FILTER (WHERE status = 'completed'), 0)::bigint      AS credits_sold,
          coalesce(sum(amount_cents) FILTER (WHERE status = 'completed'), 0)::bigint AS revenue_cents
        FROM purchases WHERE created_at >= ${iso}::timestamptz GROUP BY tenant_id
      ),
      r AS (
        SELECT tenant_id,
          count(*)::bigint                                       AS reveals,
          (count(*) FILTER (WHERE credits_consumed > 0))::bigint AS charged_reveals
        FROM contact_reveals WHERE revealed_at >= ${iso}::timestamptz GROUP BY tenant_id
      ),
      s AS (
        SELECT tenant_id, coalesce(sum(cost_micros), 0)::bigint AS provider_spend_micros
        FROM provider_calls WHERE called_at >= ${iso}::timestamptz GROUP BY tenant_id
      )
      SELECT
        t.id::text                              AS tenant_id,
        t.name                                  AS tenant_name,
        coalesce(p.revenue_cents, 0)::bigint    AS revenue_cents,
        coalesce(p.credits_sold, 0)::bigint     AS credits_sold,
        coalesce(r.reveals, 0)::bigint          AS reveals,
        coalesce(r.charged_reveals, 0)::bigint  AS charged_reveals,
        coalesce(s.provider_spend_micros, 0)::bigint AS provider_spend_micros
      FROM tenants t
      LEFT JOIN p ON p.tenant_id = t.id
      LEFT JOIN r ON r.tenant_id = t.id
      LEFT JOIN s ON s.tenant_id = t.id
      WHERE coalesce(p.revenue_cents, 0) > 0
         OR coalesce(r.reveals, 0) > 0
         OR coalesce(s.provider_spend_micros, 0) > 0
      ORDER BY coalesce(s.provider_spend_micros, 0) DESC, coalesce(p.revenue_cents, 0) DESC
      LIMIT ${limit}
    `)) as unknown as Array<{
      tenant_id: string;
      tenant_name: string;
      revenue_cents: number;
      credits_sold: number;
      reveals: number;
      charged_reveals: number;
      provider_spend_micros: number;
    }>;
    return rows.map((row) => ({
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      revenueCents: Number(row.revenue_cents),
      creditsSold: Number(row.credits_sold),
      reveals: Number(row.reveals),
      chargedReveals: Number(row.charged_reveals),
      providerSpendMicros: Number(row.provider_spend_micros),
    }));
  },

  /** One tenant's credit-pack purchases, newest first, bounded (13a Area 4). Stripe ids are not projected. */
  async listPurchases(tx: Tx, tenantId: string): Promise<PlatformPurchaseRow[]> {
    return tx
      .select({
        id: purchases.id,
        credits: purchases.credits,
        amountCents: purchases.amountCents,
        status: purchases.status,
        createdAt: purchases.createdAt,
      })
      .from(purchases)
      .where(eq(purchases.tenantId, tenantId))
      .orderBy(desc(purchases.id))
      .limit(100);
  },
};
