// platformBillingReads.ts — read-only cross-tenant billing/economics aggregation for the platform-admin
// revenue-ops surface (13a Area 4, 07 §9). Runs inside the audited withPlatformTx (owner connection, bypasses
// RLS) so it sees every tenant. Three bounded aggregate queries (purchases, contact_reveals, provider_calls),
// each filtered to the window — SUM/COUNT only, no row dump. Cost is stored in micro-dollars; the api converts
// to cents (cost_micros / 10_000), matching providerConfigRepository.

import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";

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
};
