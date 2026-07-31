// partitionMaintenance.itest.ts — `ensure_month_partitions` (migration 0084), the prerequisite E-6.4 needs
// before any table becomes partitioned.
//
// The property that matters is not "it creates partitions" but "a write cannot fall off the end of the
// calendar". partitioningFeasibility.itest.ts proves an out-of-range insert is rejected outright (23514), so
// this function is what stands between a partitioned table and a hard write outage on the first of a month.
// Everything below is aimed at that: coverage of the months it claims, idempotence (so the sweep can run as
// often as it likes), and a refusal to report success for a table it did not actually maintain.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { applyMigrations } from "../src/applyMigrations.ts";
import { type ItestDb, startItestDb } from "./itestDb.ts";

let dbHandle: ItestDb;
let sql: ReturnType<typeof postgres>;

// 180s, like every sibling itest: this hook provisions a database and runs the migration chain. Without the
// argument it inherits bun's 5s default and fails on setup cost rather than on anything it asserts.
beforeAll(async () => {
  dbHandle = await startItestDb("partition_maintenance");
  await applyMigrations(dbHandle.adminUrl);
  sql = postgres(dbHandle.adminUrl, { max: 1 });
  await sql`DROP SCHEMA IF EXISTS pm_probe CASCADE`;
  await sql`CREATE SCHEMA pm_probe`;
}, 180_000);

afterAll(async () => {
  // Optional-chained: when beforeAll times out `sql` is undefined, and an unguarded call throws a TypeError
  // that REPLACES the real failure in the output — which is exactly how the timeout stayed hidden here.
  // NB: a tagged template cannot be optional-chained (`sql?.\`…\`` is a syntax error), so this is an if.
  if (sql) await sql`DROP SCHEMA IF EXISTS pm_probe CASCADE`.catch(() => undefined);
  await sql?.end({ timeout: 5 });
  await dbHandle?.stop();
});

/** A fresh partitioned table with no partitions — the state a conversion leaves behind. */
async function makeParent(name: string): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE pm_probe.${name} (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      occurred_at timestamptz NOT NULL,
      PRIMARY KEY (id, occurred_at)
    ) PARTITION BY RANGE (occurred_at)
  `);
}

async function partitionNames(parent: string): Promise<string[]> {
  const rows = await sql.unsafe<{ relname: string }[]>(`
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_namespace n ON n.oid = p.relnamespace
     WHERE p.relname = '${parent}' AND n.nspname = 'pm_probe'
     ORDER BY c.relname
  `);
  return rows.map((r) => r.relname);
}

const ensure = async (parent: string, monthsAhead?: number): Promise<number> => {
  const arg = monthsAhead === undefined ? "" : `, ${monthsAhead}`;
  const rows = await sql.unsafe<{ created: number }[]>(
    `SELECT ensure_month_partitions('pm_probe.${parent}'::regclass${arg}) AS created`,
  );
  return Number(rows[0]?.created ?? -1);
};

describe("ensure_month_partitions", () => {
  test("creates the current month plus months_ahead, inclusive", async () => {
    await makeParent("basic");
    // 0..3 inclusive = 4 months. Off-by-one here is the difference between having next month ready and
    // discovering on the 1st that you do not.
    expect(await ensure("basic", 3)).toBe(4);
    expect(await partitionNames("basic")).toHaveLength(4);

    // Named for the month they hold, so an operator reading \\dt can tell what exists at a glance.
    const names = await partitionNames("basic");
    expect(names.every((n) => /^basic_\d{4}_\d{2}$/.test(n))).toBe(true);
  });

  test("is idempotent — a second run creates nothing", async () => {
    await makeParent("idem");
    expect(await ensure("idem", 2)).toBe(3);
    // The sweep runs daily and may run twice; it asks the catalog what exists rather than assuming it owns
    // the table, so a manually pre-created partition is left alone too.
    expect(await ensure("idem", 2)).toBe(0);
    expect(await partitionNames("idem")).toHaveLength(3);
  });

  test("extends the horizon without disturbing what is already there", async () => {
    await makeParent("extend");
    await ensure("extend", 1); // this month + next
    const before = await partitionNames("extend");
    expect(await ensure("extend", 3)).toBe(2); // adds only the two beyond the horizon
    const after = await partitionNames("extend");
    // The originals survive untouched: this must never re-create a partition that holds rows.
    expect(after).toEqual(expect.arrayContaining(before));
    expect(after).toHaveLength(4);
  });

  test("the created partitions actually accept the months they claim", async () => {
    await makeParent("writes");
    await ensure("writes", 2);
    // The whole point: a write dated two months out lands instead of failing 23514.
    const twoMonthsOut = await sql.unsafe<{ ok: boolean }[]>(`
      INSERT INTO pm_probe.writes (occurred_at)
      VALUES (date_trunc('month', CURRENT_DATE) + interval '2 months' + interval '5 days')
      RETURNING true AS ok
    `);
    expect(twoMonthsOut[0]?.ok).toBe(true);

    // And the boundary is half-open, so the last day of a month belongs to that month, not the next.
    const monthEnd = await sql.unsafe<{ ok: boolean }[]>(`
      INSERT INTO pm_probe.writes (occurred_at)
      VALUES (date_trunc('month', CURRENT_DATE) + interval '1 month' - interval '1 microsecond')
      RETURNING true AS ok
    `);
    expect(monthEnd[0]?.ok).toBe(true);
  });

  test("months_ahead = 0 creates just the current month", async () => {
    await makeParent("zero");
    expect(await ensure("zero", 0)).toBe(1);
  });

  test("REFUSES a plain table instead of quietly succeeding", async () => {
    // Doing nothing here would let a half-finished conversion look maintained — the sweep would report
    // success every day for a table with no partitions at all.
    await sql.unsafe("CREATE TABLE pm_probe.not_partitioned (id uuid PRIMARY KEY)");
    await expect(ensure("not_partitioned", 1)).rejects.toThrow(/not a partitioned table/i);
  });

  test("rejects a negative horizon rather than silently creating nothing", async () => {
    await makeParent("negative");
    await expect(ensure("negative", -1)).rejects.toThrow(/months_ahead must be >= 0/i);
  });

  test("is not granted to the tenant-facing role — creating a table is DDL", async () => {
    const [row] = await sql.unsafe<{ allowed: boolean }[]>(`
      SELECT has_function_privilege(
        'leadwolf_app', 'ensure_month_partitions(regclass, int)', 'EXECUTE'
      ) AS allowed
    `);
    expect(row?.allowed).toBe(false);
  });
});
