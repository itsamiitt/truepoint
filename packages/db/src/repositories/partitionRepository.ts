// partitionRepository.ts — keeping monthly range partitions ahead of the calendar (E-6.4).
//
// The `ensure_month_partitions` SQL function (migration 0084) creates the missing months for ONE table. This
// is the layer that decides WHICH tables: it asks the catalog for every partitioned table in `public` rather
// than carrying a hard-coded list. That matters for the order things ship in — the sweep can be registered
// now, does nothing while no table is partitioned, and starts maintaining each table the moment its
// conversion migration lands, with no second change to remember.
//
// Runs on the OWNER connection: creating a partition is DDL, and `leadwolf_app` deliberately holds no
// EXECUTE on the function (asserted in partitionMaintenance.itest.ts).
import { sql } from "drizzle-orm";
import { db, withPrivilegedTx } from "../client.ts";

/** How many months beyond the current one to keep ready. Three is deliberately generous: the sweep runs
 *  daily, so one month would already be safe — the margin is there so a sweep that has been failing quietly
 *  for weeks still has not caused a write outage by the time anyone notices. */
export const PARTITION_MONTHS_AHEAD = 3;

export interface PartitionEnsureResult {
  /** `schema.table` of each partitioned table found. */
  table: string;
  /** Partitions created this run — 0 on a steady-state day. */
  created: number;
}

export const partitionRepository = {
  /** Every partitioned table in `public` (relkind 'p'), qualified. Empty until a conversion lands. */
  async listPartitionedTables(): Promise<string[]> {
    const rows = (await db.execute(sql`
      SELECT n.nspname || '.' || c.relname AS qualified
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'p' AND n.nspname = 'public'
       ORDER BY 1
    `)) as unknown as Array<{ qualified: string }>;
    return rows.map((r) => r.qualified);
  },

  /**
   * Ensure the next `monthsAhead` months exist for every partitioned table.
   *
   * Per-table, not one transaction for all of them: a failure on one table must not roll back the partitions
   * already created for the others. A half-maintained set is strictly better than none, and the next run
   * retries whatever failed.
   */
  async ensureAll(monthsAhead: number = PARTITION_MONTHS_AHEAD): Promise<PartitionEnsureResult[]> {
    const tables = await partitionRepository.listPartitionedTables();
    const results: PartitionEnsureResult[] = [];
    for (const table of tables) {
      const created = await withPrivilegedTx(async (tx) => {
        const rows = (await tx.execute(
          sql`SELECT ensure_month_partitions(${table}::regclass, ${monthsAhead}) AS created`,
        )) as unknown as Array<{ created: number }>;
        return Number(rows[0]?.created ?? 0);
      });
      results.push({ table, created });
    }
    return results;
  },
};
