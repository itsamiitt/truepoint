// partitioningFeasibility.itest.ts — what real Postgres actually permits when the append-heavy tables
// (E-6.4) are converted to monthly range partitions.
//
// This exists because the plan item is written as though partitioning is a mechanical conversion, and the
// answer to "can we?" was being taken from memory. Three properties decide the design, and getting any of
// them wrong is the kind of thing that only surfaces the first time a migration runs against production:
//
//   1. `activities` carries a STATEMENT-level trigger with a transition table (REFERENCING NEW TABLE), which
//      maintains the contacts.last_activity_at cache. Transition tables were long restricted on partitioned
//      tables, which would have made converting `activities` a rewrite of that cache path rather than a table
//      change. On the Postgres 16 we run they are ACCEPTED — asserted below, because that answer is the
//      difference between "convert the table" and "redesign the write path", and it is version-dependent.
//   2. Partitioning forces the partition key into every UNIQUE/PRIMARY KEY constraint, so `id` alone stops
//      being a primary key. Anything with an inbound foreign key therefore drags the composite key into the
//      referencing tables too.
//   3. An insert whose key falls outside every partition FAILS. Without a DEFAULT partition, or a job that
//      creates next month's partition ahead of time, the app breaks at a month boundary — on the calendar,
//      not on load.
//
// These are recorded as executable assertions rather than prose so the plan's decision rests on the server's
// behaviour, and so a future Postgres that lifts a restriction shows up as a failing test rather than a note
// nobody re-checks.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type ItestDb, startItestDb } from "./itestDb.ts";

let dbHandle: ItestDb;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  dbHandle = await startItestDb();
  sql = postgres(dbHandle.adminUrl, { max: 1 });
  await sql`DROP SCHEMA IF EXISTS part_probe CASCADE`;
  await sql`CREATE SCHEMA part_probe`;
});

afterAll(async () => {
  await sql`DROP SCHEMA IF EXISTS part_probe CASCADE`.catch(() => undefined);
  await sql.end({ timeout: 5 });
  await dbHandle.stop();
});

/** Run a statement and return the Postgres error, or null when it succeeded. */
async function attempt(statement: string): Promise<{ code: string; message: string } | null> {
  try {
    await sql.unsafe(statement);
    return null;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { code: err.code ?? "", message: err.message ?? String(e) };
  }
}

describe("E-6.4 · what Postgres permits for monthly range partitions", () => {
  test("the partition key MUST be part of every primary/unique key", async () => {
    // This is the constraint that propagates outward: `id` alone can no longer be the primary key, so any
    // table with an inbound FK to a partitioned table needs the composite carried into it as well.
    const idOnly = await attempt(`
      CREATE TABLE part_probe.id_only (
        id uuid PRIMARY KEY,
        occurred_at timestamptz NOT NULL
      ) PARTITION BY RANGE (occurred_at)
    `);
    expect(idOnly).not.toBeNull();
    expect(idOnly?.message).toMatch(/must include all partitioning columns/i);

    // The composite is accepted, which is the shape any conversion has to adopt.
    const composite = await attempt(`
      CREATE TABLE part_probe.composite_pk (
        id uuid NOT NULL,
        occurred_at timestamptz NOT NULL,
        PRIMARY KEY (id, occurred_at)
      ) PARTITION BY RANGE (occurred_at)
    `);
    expect(composite).toBeNull();
  });

  test("a row outside every partition is REJECTED — partitions must exist before the data does", async () => {
    await sql.unsafe(`
      CREATE TABLE part_probe.no_default (
        id uuid NOT NULL,
        occurred_at timestamptz NOT NULL,
        PRIMARY KEY (id, occurred_at)
      ) PARTITION BY RANGE (occurred_at)
    `);
    await sql.unsafe(`
      CREATE TABLE part_probe.no_default_2026_01 PARTITION OF part_probe.no_default
        FOR VALUES FROM ('2026-01-01') TO ('2026-02-01')
    `);

    // Inside the created month: fine.
    const inRange = await attempt(`
      INSERT INTO part_probe.no_default (id, occurred_at)
      VALUES (gen_random_uuid(), '2026-01-15T00:00:00Z')
    `);
    expect(inRange).toBeNull();

    // One month later — the calendar alone breaks writes. This is why partitioning REQUIRES either a
    // DEFAULT partition or a job that creates the next month ahead of time; it is an operational
    // component, not a schema change.
    const outOfRange = await attempt(`
      INSERT INTO part_probe.no_default (id, occurred_at)
      VALUES (gen_random_uuid(), '2026-02-15T00:00:00Z')
    `);
    expect(outOfRange).not.toBeNull();
    expect(outOfRange?.code).toBe("23514"); // check_violation: no partition found for row
  });

  test("a DEFAULT partition catches those rows (at the cost of a scan on every future attach)", async () => {
    await sql.unsafe(`
      CREATE TABLE part_probe.with_default (
        id uuid NOT NULL,
        occurred_at timestamptz NOT NULL,
        PRIMARY KEY (id, occurred_at)
      ) PARTITION BY RANGE (occurred_at)
    `);
    await sql.unsafe(
      "CREATE TABLE part_probe.with_default_dflt PARTITION OF part_probe.with_default DEFAULT",
    );
    const anyDate = await attempt(`
      INSERT INTO part_probe.with_default (id, occurred_at)
      VALUES (gen_random_uuid(), '2031-07-04T00:00:00Z')
    `);
    expect(anyDate).toBeNull();
  });

  test("a TRANSITION TABLE trigger is accepted on a partitioned table (so activities is not blocked)", async () => {
    // The exact shape rls/activity.sql installs: an AFTER INSERT ... FOR EACH STATEMENT trigger with
    // REFERENCING NEW TABLE, which is what makes the contacts.last_activity_at update one aggregate per
    // statement instead of one UPDATE per row.
    await sql.unsafe(`
      CREATE TABLE part_probe.acts (
        id uuid NOT NULL,
        contact_id uuid NOT NULL,
        occurred_at timestamptz NOT NULL,
        PRIMARY KEY (id, occurred_at)
      ) PARTITION BY RANGE (occurred_at)
    `);
    await sql.unsafe(`
      CREATE TABLE part_probe.acts_2026_01 PARTITION OF part_probe.acts
        FOR VALUES FROM ('2026-01-01') TO ('2026-02-01')
    `);
    await sql.unsafe(`
      CREATE FUNCTION part_probe.probe_fn() RETURNS trigger AS $fn$
      BEGIN
        PERFORM count(*) FROM new_rows;
        RETURN NULL;
      END;
      $fn$ LANGUAGE plpgsql
    `);

    const withTransition = await attempt(`
      CREATE TRIGGER probe_trigger AFTER INSERT ON part_probe.acts
        REFERENCING NEW TABLE AS new_rows
        FOR EACH STATEMENT EXECUTE FUNCTION part_probe.probe_fn()
    `);

    // Postgres 16 accepts this. It is asserted rather than tolerated because the whole shape of the
    // `activities` conversion depends on it: rejected, and the contacts.last_activity_at cache would have to
    // be rebuilt (per-row triggers, or moving the aggregate into the write path) BEFORE the table could be
    // partitioned at all. Pinning it means a downgrade to a server that restricts transition tables fails
    // here, loudly, instead of at the first migration against it.
    expect(withTransition).toBeNull();
  });

  test("an inbound foreign key must reference the WHOLE key, not just id", async () => {
    // source_imports and credit_ledger are referenced by four other tables. Once their key is composite, a
    // referencing table cannot keep a plain `source_import_id uuid REFERENCES source_imports(id)`.
    await sql.unsafe(`
      CREATE TABLE part_probe.parent (
        id uuid NOT NULL,
        created_at timestamptz NOT NULL,
        PRIMARY KEY (id, created_at)
      ) PARTITION BY RANGE (created_at)
    `);
    await sql.unsafe("CREATE TABLE part_probe.parent_dflt PARTITION OF part_probe.parent DEFAULT");

    const idOnlyFk = await attempt(`
      CREATE TABLE part_probe.child_id_only (
        id uuid PRIMARY KEY,
        parent_id uuid REFERENCES part_probe.parent (id)
      )
    `);
    expect(idOnlyFk).not.toBeNull();
    expect(idOnlyFk?.message).toMatch(/unique constraint|referenced table/i);

    // Carrying both columns works — and that is the cost: every referencing table gains a column, and every
    // write path that inserts one of these references has to supply it.
    const compositeFk = await attempt(`
      CREATE TABLE part_probe.child_composite (
        id uuid PRIMARY KEY,
        parent_id uuid,
        parent_created_at timestamptz,
        FOREIGN KEY (parent_id, parent_created_at) REFERENCES part_probe.parent (id, created_at)
      )
    `);
    expect(compositeFk).toBeNull();
  });
});
