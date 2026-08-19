// marketRollupRepository.ts — the market-segment rollup cache (0130, MI-S7). Two halves:
//   rebuild()      — SYSTEM-only, OWNER connection (the sweep): delete + re-insert the whole window in
//                    one transaction. The deliberate exception to "er writes Layer 0" — a cache rebuild
//                    needs DELETE, and the er role's never-DELETE posture stays intact.
//   readSegments() — the API seam, under withErTx (SELECT-only grant). Non-PII aggregates by
//                    construction: counts and sums over organization dimensions.
// Every board number must reconcile with a drill-down search (09-roadmap AC) — which is why the
// dimensions here are exactly the account-search facets (industry node, country, employee band).

import { sql } from "drizzle-orm";
import { type Tx, db } from "../client.ts";

export interface MarketSegmentRow {
  industryCode: string;
  hqCountry: string;
  employeeBand: string;
  month: string;
  companyCount: number;
  headcountDelta: number;
  fundingRounds: number;
  fundingAmountMinor: number;
  signalCount: number;
}

export const marketRollupRepository = {
  /**
   * Full-window rebuild (SYSTEM sweep only). Idempotent: one transaction, DELETE + INSERT..SELECT.
   * Row count is bounded by (distinct dimension combos × months) — combos are capped by the taxonomy ×
   * country × band vocabulary, not by graph size.
   */
  async rebuild(monthsBack = 12): Promise<{ rows: number }> {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM master_market_rollups`);
      const inserted = (await tx.execute(sql`
        WITH dims AS (
          SELECT c.id AS company_id,
                 coalesce(i.code, '')        AS industry_code,
                 coalesce(c.hq_country, '')  AS hq_country,
                 coalesce(c.employee_band, '') AS employee_band
            FROM master_companies c
            LEFT JOIN master_industries i ON i.id = c.industry_id
        ),
        months AS (
          SELECT (date_trunc('month', now()) - make_interval(months => gs))::date AS month
            FROM generate_series(0, ${monthsBack - 1}) AS gs
        ),
        counts AS (
          SELECT industry_code, hq_country, employee_band, count(*)::int AS company_count
            FROM dims GROUP BY 1, 2, 3
        ),
        funding AS (
          SELECT d.industry_code, d.hq_country, d.employee_band,
                 date_trunc('month', f.announced_on)::date AS month,
                 count(*)::int AS rounds, coalesce(sum(f.amount_minor), 0)::bigint AS amount
            FROM master_company_funding f
            JOIN dims d ON d.company_id = f.master_company_id
           WHERE f.announced_on IS NOT NULL
           GROUP BY 1, 2, 3, 4
        ),
        sigs AS (
          SELECT d.industry_code, d.hq_country, d.employee_band,
                 date_trunc('month', s.observed_at)::date AS month, count(*)::int AS n
            FROM master_signals s
            JOIN dims d ON d.company_id = s.subject_id
           WHERE s.subject_type = 'company'
           GROUP BY 1, 2, 3, 4
        ),
        hc AS (
          SELECT d.industry_code, d.hq_country, d.employee_band, h.month,
                 sum(h.employee_count - prev.employee_count)::bigint AS delta
            FROM master_company_headcount h
            JOIN master_company_headcount prev
              ON prev.master_company_id = h.master_company_id
             AND prev.job_function = '' AND prev.month = (h.month - interval '1 month')::date
            JOIN dims d ON d.company_id = h.master_company_id
           WHERE h.job_function = ''
           GROUP BY 1, 2, 3, 4
        )
        INSERT INTO master_market_rollups
          (industry_code, hq_country, employee_band, month, company_count,
           headcount_delta, funding_rounds, funding_amount_minor, signal_count)
        SELECT c.industry_code, c.hq_country, c.employee_band, m.month, c.company_count,
               coalesce(hc.delta, 0), coalesce(f.rounds, 0), coalesce(f.amount, 0),
               coalesce(sg.n, 0)
          FROM counts c
         CROSS JOIN months m
          LEFT JOIN funding f USING (industry_code, hq_country, employee_band, month)
          LEFT JOIN sigs sg  ON sg.industry_code = c.industry_code AND sg.hq_country = c.hq_country
                            AND sg.employee_band = c.employee_band AND sg.month = m.month
          LEFT JOIN hc       ON hc.industry_code = c.industry_code AND hc.hq_country = c.hq_country
                            AND hc.employee_band = c.employee_band AND hc.month = m.month
        RETURNING 1
      `)) as unknown as unknown[];
      return inserted.length;
    });
    return { rows: result };
  },

  /** The board read (withErTx): the window, newest month first. */
  async readSegments(tx: Tx, opts: { months?: number } = {}): Promise<MarketSegmentRow[]> {
    const months = Math.min(opts.months ?? 6, 24);
    const rows = (await tx.execute(sql`
      SELECT industry_code, hq_country, employee_band, month::text AS month, company_count,
             headcount_delta, funding_rounds, funding_amount_minor, signal_count
        FROM master_market_rollups
       WHERE month >= (date_trunc('month', now()) - make_interval(months => ${months - 1}))::date
       ORDER BY month DESC, industry_code, hq_country, employee_band
    `)) as unknown as Array<{
      industry_code: string;
      hq_country: string;
      employee_band: string;
      month: string;
      company_count: number;
      headcount_delta: string | number;
      funding_rounds: number;
      funding_amount_minor: string | number;
      signal_count: number;
    }>;
    return rows.map((r) => ({
      industryCode: r.industry_code,
      hqCountry: r.hq_country,
      employeeBand: r.employee_band,
      month: r.month,
      companyCount: r.company_count,
      headcountDelta: Number(r.headcount_delta),
      fundingRounds: r.funding_rounds,
      fundingAmountMinor: Number(r.funding_amount_minor),
      signalCount: r.signal_count,
    }));
  },
};
