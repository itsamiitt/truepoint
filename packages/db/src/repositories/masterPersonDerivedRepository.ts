// masterPersonDerivedRepository.ts — writers for the three DERIVED person facets (migration 0136,
// search-consolidation stage 5): title_function, career_started_on, primary_started_on.
//
// Two entry points, deliberately different shapes:
//   • recomputeEmploymentDatesTx — called by the landing INSIDE the transaction that just wrote a person's
//     stints, so the derived dates can never lag the rows they derive from;
//   • the two backfill helpers — bounded, keyset-driven sweeps an operator runs once over rows that predate
//     the column. Bounded because an unbounded UPDATE over the graph is a lock and a WAL spike, not a task.
//
// THE '-infinity' SENTINEL is the correctness of this module. master_employment.started_on defaults to it,
// meaning "start unknown"; it is not a date. A plain min() returns it for anyone with one undated stint and
// the derived "years of experience" is roughly two thousand. Every aggregate here excludes it explicitly.
//
// Runs under the caller's withErTx (leadwolf_er).
import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";

export const masterPersonDerivedRepository = {
  /**
   * Recompute the two employment-derived dates for ONE person from their stints. Idempotent, and safe to
   * call after any stint write — it reads the rows back rather than trusting what the caller thinks it just
   * wrote, so a partial write or a concurrent landing cannot leave the derived values describing a shape
   * that no longer exists.
   */
  async recomputeEmploymentDatesTx(tx: Tx, masterPersonId: string): Promise<void> {
    await tx.execute(sql`
      UPDATE master_persons p
         SET career_started_on = agg.career_start,
             primary_started_on = agg.primary_start,
             updated_at = now()
        FROM (
          SELECT min(e.started_on) FILTER (WHERE e.started_on <> '-infinity'::date) AS career_start,
                 min(e.started_on) FILTER (
                   WHERE e.is_primary AND e.started_on <> '-infinity'::date
                 ) AS primary_start
            FROM master_employment e
           WHERE e.master_person_id = ${masterPersonId}
        ) agg
       WHERE p.id = ${masterPersonId}
         AND (p.career_started_on IS DISTINCT FROM agg.career_start
              OR p.primary_started_on IS DISTINCT FROM agg.primary_start)
    `);
  },

  /** Set the derived job function for one person. Null clears it — an unresolvable title is a real gap. */
  async setTitleFunctionTx(
    tx: Tx,
    masterPersonId: string,
    titleFunction: string | null,
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE master_persons
         SET title_function = ${titleFunction}, updated_at = now()
       WHERE id = ${masterPersonId} AND title_function IS DISTINCT FROM ${titleFunction}
    `);
  },

  /**
   * One BOUNDED page of persons whose title_function has not been derived yet, for the operator backfill.
   * Keyset by id so repeated calls walk forward instead of re-reading the same head — an OFFSET sweep over
   * a growing table re-scans what it already did.
   *
   * Only rows with a title are returned: a person with no job_title has nothing to derive from, and
   * including them would make the sweep never terminate (they would come back every page, forever
   * un-derived).
   */
  async listForTitleFunctionBackfillTx(
    tx: Tx,
    afterId: string | null,
    limit: number,
  ): Promise<Array<{ id: string; jobTitle: string }>> {
    const seek = afterId ? sql`AND p.id > ${afterId}::uuid` : sql``;
    const rows = (await tx.execute(sql`
      SELECT p.id, p.job_title
        FROM master_persons p
       WHERE p.title_function IS NULL AND p.job_title IS NOT NULL ${seek}
       ORDER BY p.id
       LIMIT ${limit}
    `)) as unknown as Array<{ id: string; job_title: string }>;
    return rows.map((r) => ({ id: r.id, jobTitle: r.job_title }));
  },

  /**
   * The employment-date backfill for rows that predate 0136. The migration itself runs this once as a
   * single statement; this bounded version exists for a re-run after a bulk landing, where a
   * whole-table UPDATE would be a lock and a WAL spike rather than a task.
   *
   * Returns the last id processed so the caller can page; null when there was nothing left to do.
   */
  async backfillEmploymentDatesTx(
    tx: Tx,
    afterId: string | null,
    limit: number,
  ): Promise<string | null> {
    const seek = afterId ? sql`AND p.id > ${afterId}::uuid` : sql``;
    const rows = (await tx.execute(sql`
      WITH page AS (
        SELECT p.id FROM master_persons p
         WHERE p.career_started_on IS NULL ${seek}
         ORDER BY p.id
         LIMIT ${limit}
      ), agg AS (
        SELECT e.master_person_id,
               min(e.started_on) FILTER (WHERE e.started_on <> '-infinity'::date) AS career_start,
               min(e.started_on) FILTER (
                 WHERE e.is_primary AND e.started_on <> '-infinity'::date
               ) AS primary_start
          FROM master_employment e
          JOIN page ON page.id = e.master_person_id
         GROUP BY e.master_person_id
      )
      UPDATE master_persons p
         SET career_started_on = agg.career_start,
             primary_started_on = agg.primary_start,
             updated_at = now()
        FROM agg
       WHERE p.id = agg.master_person_id
      RETURNING p.id
    `)) as unknown as Array<{ id: string }>;
    // The page is ordered by id, but RETURNING is not — take the max explicitly rather than the last row,
    // or the cursor can go BACKWARDS and the sweep loops forever over the same page.
    return rows.length === 0
      ? null
      : (rows
          .map((r) => r.id)
          .sort()
          .at(-1) ?? null);
  },
};
