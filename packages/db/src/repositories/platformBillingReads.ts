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

/** One day of the economics trend — gap-filled daily revenue + reveals + credits consumed over the window. */
export interface EconomicsTrendRow {
  day: string; // YYYY-MM-DD (UTC)
  revenueCents: number;
  reveals: number;
  creditsConsumed: number;
}

/** One active tenant at/under a credit-balance threshold (the proactive top-up / churn-risk view). The owner +
 *  default-workspace target are for the low-balance notifier producer (G-NTF-1); the admin read ignores them. */
export interface LowBalanceTenantRow {
  tenantId: string;
  tenantName: string;
  plan: string;
  revealCreditBalance: number;
  ownerUserId: string | null;
  defaultWorkspaceId: string | null;
}

/** One tenant whose live counter disagrees with its credit-ledger sum (M11 reconciliation drift, ADR-0029). */
export interface CreditDriftRow {
  tenantId: string;
  tenantName: string;
  counter: number;
  ledgerSum: number;
  drift: number; // counter - ledgerSum (0 for a fully-ledgered tenant)
  entryCount: number;
}

/** One tenant's windowed + lifetime economics aggregate — provider spend stays in micros (the api converts to
 *  cents and derives margin / cost-per-reveal). `lastPurchaseAt` = newest completed top-up, or null. */
export interface TenantEconomicsDetailAggregate {
  tenantId: string;
  tenantName: string;
  plan: string;
  revealCreditBalance: number;
  // window [since, now]
  revenueCents: number;
  refundedCents: number;
  creditsSold: number;
  creditsConsumed: number;
  reveals: number;
  chargedReveals: number;
  providerSpendMicros: number;
  // lifetime (all-time)
  lifetimeRevenueCents: number;
  lifetimeRefundedCents: number;
  lifetimeCreditsSold: number;
  lifetimeCreditsConsumed: number;
  lastPurchaseAt: Date | null;
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

  /** The economics daily trend over `[since, now]` — a GAP-FILLED time series (every day present, zeros where
   *  no activity) of revenue, reveals and credits consumed, oldest first. `generate_series` builds the day
   *  spine (UTC) and the purchases/reveals daily aggregates LEFT JOIN onto it. Bounded by the window (≤365 d).
   *  Owner read (cross-tenant). */
  async economicsTrend(tx: Tx, since: Date): Promise<EconomicsTrendRow[]> {
    const iso = since.toISOString();
    const rows = (await tx.execute(sql`
      WITH days AS (
        SELECT to_char(d, 'YYYY-MM-DD') AS day
        FROM generate_series(
          date_trunc('day', ${iso}::timestamptz),
          date_trunc('day', now()),
          interval '1 day'
        ) AS d
      ),
      p AS (
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
          coalesce(sum(amount_cents) FILTER (WHERE status = 'completed'), 0)::bigint AS revenue_cents
        FROM purchases WHERE created_at >= ${iso}::timestamptz GROUP BY 1
      ),
      r AS (
        SELECT to_char(date_trunc('day', revealed_at), 'YYYY-MM-DD') AS day,
          count(*)::bigint                            AS reveals,
          coalesce(sum(credits_consumed), 0)::bigint  AS credits_consumed
        FROM contact_reveals WHERE revealed_at >= ${iso}::timestamptz GROUP BY 1
      )
      SELECT
        days.day                             AS day,
        coalesce(p.revenue_cents, 0)::bigint AS revenue_cents,
        coalesce(r.reveals, 0)::bigint       AS reveals,
        coalesce(r.credits_consumed, 0)::bigint AS credits_consumed
      FROM days
      LEFT JOIN p ON p.day = days.day
      LEFT JOIN r ON r.day = days.day
      ORDER BY days.day ASC
    `)) as unknown as Array<{
      day: string;
      revenue_cents: number;
      reveals: number;
      credits_consumed: number;
    }>;
    return rows.map((row) => ({
      day: row.day,
      revenueCents: Number(row.revenue_cents),
      reveals: Number(row.reveals),
      creditsConsumed: Number(row.credits_consumed),
    }));
  },

  /** ONE tenant's economics daily trend over `[since, now]` — a GAP-FILLED time series (revenue / reveals /
   *  credits consumed per day, oldest first) for a single tenant: the account-level health signal (usage
   *  ramping up vs going dormant → churn risk). Same generate_series spine as economicsTrend, but every
   *  aggregate is filtered to `tenantId`. Bounded by the window (≤365 points). Owner read. */
  async economicsTrendForTenant(
    tx: Tx,
    tenantId: string,
    since: Date,
  ): Promise<EconomicsTrendRow[]> {
    const iso = since.toISOString();
    const rows = (await tx.execute(sql`
      WITH days AS (
        SELECT to_char(d, 'YYYY-MM-DD') AS day
        FROM generate_series(
          date_trunc('day', ${iso}::timestamptz),
          date_trunc('day', now()),
          interval '1 day'
        ) AS d
      ),
      p AS (
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
          coalesce(sum(amount_cents) FILTER (WHERE status = 'completed'), 0)::bigint AS revenue_cents
        FROM purchases
        WHERE tenant_id = ${tenantId} AND created_at >= ${iso}::timestamptz GROUP BY 1
      ),
      r AS (
        SELECT to_char(date_trunc('day', revealed_at), 'YYYY-MM-DD') AS day,
          count(*)::bigint                            AS reveals,
          coalesce(sum(credits_consumed), 0)::bigint  AS credits_consumed
        FROM contact_reveals
        WHERE tenant_id = ${tenantId} AND revealed_at >= ${iso}::timestamptz GROUP BY 1
      )
      SELECT
        days.day                             AS day,
        coalesce(p.revenue_cents, 0)::bigint AS revenue_cents,
        coalesce(r.reveals, 0)::bigint       AS reveals,
        coalesce(r.credits_consumed, 0)::bigint AS credits_consumed
      FROM days
      LEFT JOIN p ON p.day = days.day
      LEFT JOIN r ON r.day = days.day
      ORDER BY days.day ASC
    `)) as unknown as Array<{
      day: string;
      revenue_cents: number;
      reveals: number;
      credits_consumed: number;
    }>;
    return rows.map((row) => ({
      day: row.day,
      revenueCents: Number(row.revenue_cents),
      reveals: Number(row.reveals),
      creditsConsumed: Number(row.credits_consumed),
    }));
  },

  /** Active tenants at/under a reveal-credit-balance threshold, lowest first, bounded — the proactive top-up /
   *  churn-risk view (07 §9). Owner read; the balance is the live tenant counter. */
  async lowBalanceTenants(
    tx: Tx,
    threshold: number,
    limit: number,
  ): Promise<LowBalanceTenantRow[]> {
    const rows = (await tx.execute(sql`
      SELECT t.id::text AS tenant_id, t.name AS tenant_name, t.plan, t.reveal_credit_balance,
        (SELECT tm.user_id::text FROM tenant_members tm
           WHERE tm.tenant_id = t.id AND tm.is_tenant_owner = true AND tm.status = 'active'
           ORDER BY tm.user_id LIMIT 1)                                   AS owner_user_id,
        (SELECT w.id::text FROM workspaces w
           WHERE w.tenant_id = t.id AND w.is_default = true
           ORDER BY w.id LIMIT 1)                                          AS default_workspace_id
      FROM tenants t
      WHERE t.status = 'active' AND t.reveal_credit_balance <= ${threshold}
      ORDER BY t.reveal_credit_balance ASC, t.id
      LIMIT ${limit}
    `)) as unknown as Array<{
      tenant_id: string;
      tenant_name: string;
      plan: string;
      reveal_credit_balance: number;
      owner_user_id: string | null;
      default_workspace_id: string | null;
    }>;
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      plan: r.plan,
      revealCreditBalance: Number(r.reveal_credit_balance),
      ownerUserId: r.owner_user_id,
      defaultWorkspaceId: r.default_workspace_id,
    }));
  },

  /** Credit-ledger reconciliation (M11, ADR-0029): active tenants whose live counter DISAGREES with
   *  SUM(credit_ledger.delta) — the drift the billing-recon sweep flags. `drift = counter - ledgerSum`
   *  (positive = counter ahead of the ledger). A pre-ledger tenant reads as its whole un-backfilled balance
   *  until the historical backfill runs; a FULLY-ledgered tenant must read 0 (a non-zero drift there is a real
   *  bug — a mutation that skipped its entry). Owner read; bounded, largest |drift| first. */
  async reconcileDrift(tx: Tx, limit: number): Promise<CreditDriftRow[]> {
    const rows = (await tx.execute(sql`
      SELECT t.id::text AS tenant_id, t.name AS tenant_name,
        t.reveal_credit_balance AS counter,
        COALESCE((SELECT SUM(cl.delta) FROM credit_ledger cl WHERE cl.tenant_id = t.id), 0)::bigint AS ledger_sum,
        (SELECT COUNT(*) FROM credit_ledger cl WHERE cl.tenant_id = t.id)::bigint AS entry_count
      FROM tenants t
      WHERE t.status = 'active'
        AND t.reveal_credit_balance <> COALESCE((SELECT SUM(cl.delta) FROM credit_ledger cl WHERE cl.tenant_id = t.id), 0)
      ORDER BY abs(t.reveal_credit_balance - COALESCE((SELECT SUM(cl.delta) FROM credit_ledger cl WHERE cl.tenant_id = t.id), 0)) DESC, t.id
      LIMIT ${limit}
    `)) as unknown as Array<{
      tenant_id: string;
      tenant_name: string;
      counter: number;
      ledger_sum: number;
      entry_count: number;
    }>;
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      counter: Number(r.counter),
      ledgerSum: Number(r.ledger_sum),
      drift: Number(r.counter) - Number(r.ledger_sum),
      entryCount: Number(r.entry_count),
    }));
  },

  /** One tenant's economics detail — the per-tenant drill-down (complements economicsByTenant). Same three
   *  money sources (purchases, reveals, provider spend), filtered to ONE tenant, returning BOTH the windowed
   *  `[since, now]` slice and the lifetime totals, plus the live balance/plan and the last completed top-up.
   *  Four bounded aggregate scans (each filtered by tenant_id + indexed time column). Returns null if the
   *  tenant id does not exist. Owner read (cross-tenant bypass), so the route audits + bounds it. */
  async economicsForTenant(
    tx: Tx,
    tenantId: string,
    since: Date,
  ): Promise<TenantEconomicsDetailAggregate | null> {
    const iso = since.toISOString();

    const [t] = (await tx.execute(sql`
      SELECT id::text AS tenant_id, name AS tenant_name, plan, reveal_credit_balance
      FROM tenants WHERE id = ${tenantId}
    `)) as unknown as Array<{
      tenant_id: string;
      tenant_name: string;
      plan: string;
      reveal_credit_balance: number;
    }>;
    if (!t) return null;

    const [p] = (await tx.execute(sql`
      SELECT
        coalesce(sum(credits)      FILTER (WHERE status='completed' AND created_at >= ${iso}::timestamptz), 0)::bigint AS w_credits_sold,
        coalesce(sum(amount_cents) FILTER (WHERE status='completed' AND created_at >= ${iso}::timestamptz), 0)::bigint AS w_revenue_cents,
        coalesce(sum(amount_cents) FILTER (WHERE status='refunded'  AND created_at >= ${iso}::timestamptz), 0)::bigint AS w_refunded_cents,
        coalesce(sum(credits)      FILTER (WHERE status='completed'), 0)::bigint AS l_credits_sold,
        coalesce(sum(amount_cents) FILTER (WHERE status='completed'), 0)::bigint AS l_revenue_cents,
        coalesce(sum(amount_cents) FILTER (WHERE status='refunded'),  0)::bigint AS l_refunded_cents,
        max(created_at) FILTER (WHERE status='completed')                        AS last_purchase_at
      FROM purchases WHERE tenant_id = ${tenantId}
    `)) as unknown as Array<{
      w_credits_sold: number;
      w_revenue_cents: number;
      w_refunded_cents: number;
      l_credits_sold: number;
      l_revenue_cents: number;
      l_refunded_cents: number;
      last_purchase_at: string | Date | null;
    }>;

    const [r] = (await tx.execute(sql`
      SELECT
        coalesce(sum(credits_consumed) FILTER (WHERE revealed_at >= ${iso}::timestamptz), 0)::bigint AS w_consumed,
        (count(*) FILTER (WHERE revealed_at >= ${iso}::timestamptz))::bigint                         AS w_reveals,
        (count(*) FILTER (WHERE revealed_at >= ${iso}::timestamptz AND credits_consumed > 0))::bigint AS w_charged,
        coalesce(sum(credits_consumed), 0)::bigint                                                   AS l_consumed
      FROM contact_reveals WHERE tenant_id = ${tenantId}
    `)) as unknown as Array<{
      w_consumed: number;
      w_reveals: number;
      w_charged: number;
      l_consumed: number;
    }>;

    const [s] = (await tx.execute(sql`
      SELECT coalesce(sum(cost_micros), 0)::bigint AS w_provider_micros
      FROM provider_calls WHERE tenant_id = ${tenantId} AND called_at >= ${iso}::timestamptz
    `)) as unknown as Array<{ w_provider_micros: number }>;

    return {
      tenantId: t.tenant_id,
      tenantName: t.tenant_name,
      plan: t.plan,
      revealCreditBalance: Number(t.reveal_credit_balance),
      revenueCents: Number(p?.w_revenue_cents ?? 0),
      refundedCents: Number(p?.w_refunded_cents ?? 0),
      creditsSold: Number(p?.w_credits_sold ?? 0),
      creditsConsumed: Number(r?.w_consumed ?? 0),
      reveals: Number(r?.w_reveals ?? 0),
      chargedReveals: Number(r?.w_charged ?? 0),
      providerSpendMicros: Number(s?.w_provider_micros ?? 0),
      lifetimeRevenueCents: Number(p?.l_revenue_cents ?? 0),
      lifetimeRefundedCents: Number(p?.l_refunded_cents ?? 0),
      lifetimeCreditsSold: Number(p?.l_credits_sold ?? 0),
      lifetimeCreditsConsumed: Number(r?.l_consumed ?? 0),
      lastPurchaseAt: p?.last_purchase_at ? new Date(p.last_purchase_at) : null,
    };
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
