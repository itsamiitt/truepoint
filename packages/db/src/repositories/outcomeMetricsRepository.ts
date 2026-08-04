// outcomeMetricsRepository.ts — the Phase 1 outcome metrics, read off `usage_event`
// (08-architecture § Instrumentation; 06-roadmap Phase 1 "Instrument: reveal latency, reveal-hit rate,
// reveal-miss log, save success, badge impressions").
//
// WHY THIS EXISTS SEPARATELY FROM THE FIVE SHIPPED METERS: none of them can answer these questions.
// contact_reveals records what was charged, not what was ATTEMPTED and missed — so a reveal-hit rate computed
// from it would be 100% by construction, because a miss never creates a claim row. That is precisely the
// number Phase 1's kill criterion is judged on ("reveal-hit rate <40% in the beachhead → stop"), so getting it
// from the wrong table would produce a confident, meaningless answer.
//
// Every read here is workspace-scoped by RLS (rls/usageEvents.sql) and must run under withTenantTx. Staff
// cross-tenant rollups are a separate, owner-path concern and deliberately not served here.

import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";

export interface RevealOutcomeMetrics {
  /** Reveals that exposed or owned at least one field. */
  hits: number;
  /** Lookups that found nothing — the demand signal, and the numerator's complement. */
  misses: number;
  /**
   * hits / (hits + misses), or null when nothing has been attempted. NULL rather than 0: "no data yet" and
   * "every attempt missed" are opposite conclusions, and a kill criterion that cannot tell them apart would
   * stop the project on an empty table.
   */
  hitRate: number | null;
  /** Server-side p95 in ms (see revealContact: server time, a lower bound on click-to-displayed). */
  p95ServerMs: number | null;
}

export const outcomeMetricsRepository = {
  /** Reveal hit-rate + latency over a window. `sinceDays` null = all time. */
  async revealOutcomes(tx: Tx, sinceDays: number | null = 30): Promise<RevealOutcomeMetrics> {
    const since =
      sinceDays === null
        ? sql`'-infinity'::timestamptz`
        : // The ::int cast is load-bearing, not decoration. A bound parameter in named-argument notation gives
          // Postgres nothing to infer from — `make_interval(days => $1)` can fail outright with "could not
          // determine data type of parameter $1". The cast pins it.
          sql`now() - make_interval(days => ${sinceDays}::int)`;

    const rows = (await tx.execute(sql`
      SELECT
        count(*) FILTER (WHERE action = 'reveal')::int      AS hits,
        count(*) FILTER (WHERE action = 'reveal_miss')::int AS misses,
        -- percentile_cont over the metadata key the reveal path writes. Rows WITHOUT it (a miss, or a row
        -- written before latency was recorded) are excluded rather than counted as 0 — a zero would drag the
        -- p95 down and make a slow path look fast, which is the failure mode where a latency SLO passes while
        -- users wait.
        --
        -- The FILTER uses jsonb_typeof(), NOT the jsonb key-exists operator, for two independent reasons.
        --   1. CORRECTNESS. The ::numeric cast THROWS on a non-numeric value, so a key-exists filter would
        --      still feed the cast a string and take the entire metrics query down with it. metadata is jsonb
        --      written by several call sites and nothing constrains this key's type, so that is a live hazard.
        --      Admitting only JSON numbers makes the cast unfailable.
        --   2. PORTABILITY. The key-exists operator is a parameter placeholder in several drivers, and no
        --      other query in this repo relies on it passing through.
        -- NOTE: no backticks in this comment, deliberately. It lives inside a tagged template literal, so a
        -- backtick here TERMINATES the SQL string — which is exactly the bug this comment once caused.
        percentile_cont(0.95) WITHIN GROUP (
          ORDER BY (metadata->>'serverMs')::numeric
        ) FILTER (WHERE jsonb_typeof(metadata->'serverMs') = 'number') AS p95_server_ms
      FROM usage_event
      WHERE action IN ('reveal','reveal_miss')
        AND occurred_at >= ${since}
    `)) as unknown as Array<{
      hits: number;
      misses: number;
      p95_server_ms: string | number | null;
    }>;

    const row = rows[0];
    const hits = Number(row?.hits ?? 0);
    const misses = Number(row?.misses ?? 0);
    const attempted = hits + misses;
    return {
      hits,
      misses,
      hitRate: attempted === 0 ? null : hits / attempted,
      p95ServerMs: row?.p95_server_ms == null ? null : Number(row.p95_server_ms),
    };
  },

  /**
   * The most-wanted feed (07 § channel 7): which fingerprints were sought most and not found.
   *
   * COMPLIANCE OBLIGATION ON THIS READ, stated where the read lives rather than only in the writer: a
   * fingerprint here identifies a person we hold NOTHING about, so an opt-out cannot reach them by record.
   * Any surface that renders this MUST suppression-check each fingerprint against suppression_list's
   * email_blind_index first — they share a key space precisely so that check is possible. This method returns
   * raw demand and does not perform that check; the caller that surfaces it owes it. Nothing surfaces this
   * today, which is why the feed itself is Phase 3.
   */
  async mostWanted(
    tx: Tx,
    limit = 50,
  ): Promise<Array<{ fingerprint: Uint8Array; demandCount: number }>> {
    const rows = (await tx.execute(sql`
      SELECT subject_fingerprint AS fingerprint, count(*)::int AS demand_count
        FROM usage_event
       WHERE action = 'reveal_miss' AND subject_fingerprint IS NOT NULL
       GROUP BY subject_fingerprint
       ORDER BY demand_count DESC
       LIMIT ${limit}
    `)) as unknown as Array<{ fingerprint: Uint8Array; demand_count: number }>;
    return rows.map((r) => ({ fingerprint: r.fingerprint, demandCount: Number(r.demand_count) }));
  },

  /** Counts per metered action over a window — the raw material for the per-outcome dashboard panels. */
  async actionCounts(tx: Tx, sinceDays = 30): Promise<Record<string, number>> {
    const rows = (await tx.execute(sql`
      SELECT action, count(*)::int AS n
        FROM usage_event
       WHERE occurred_at >= now() - make_interval(days => ${sinceDays}::int)
       GROUP BY action
    `)) as unknown as Array<{ action: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.action, Number(r.n)]));
  },
};
