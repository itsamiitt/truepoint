-- 0084_partition_maintenance.sql — the partition-maintenance primitive E-6.4 needs BEFORE any table is
-- converted to monthly range partitions.
--
-- Why this ships first, alone, and touches no existing table: an INSERT whose partition key falls outside
-- every partition is REJECTED (23514 check_violation — proven in partitioningFeasibility.itest.ts). So a
-- partitioned table without something creating next month's partition ahead of time does not degrade under
-- load, it stops accepting writes on a CALENDAR boundary. That makes this function a prerequisite of the
-- conversion, not a follow-up to it.
--
-- Idempotent by construction: it asks the catalog which months already exist and creates only the missing
-- ones, so the sweep can run every day, twice, or after a manual `CREATE TABLE ... PARTITION OF` without
-- caring. It never drops or detaches anything — archival is a separate, deliberate operation, and a
-- maintenance job that can delete partitions is a maintenance job that can delete data.

-- Create any missing monthly partitions for `target`, from the CURRENT month through `months_ahead` months
-- out. Returns the number created.
--
-- `regclass` rather than text so a typo'd or non-existent table fails at the call site with a clear error
-- rather than inside a format() string. `format(%I)` still quotes the generated partition names.
CREATE OR REPLACE FUNCTION ensure_month_partitions(target regclass, months_ahead int DEFAULT 3)
RETURNS int AS $$
DECLARE
  parent_ns   text;
  parent_name text;
  part_name   text;
  month_start date;
  created     int := 0;
  i           int;
BEGIN
  IF months_ahead < 0 THEN
    RAISE EXCEPTION 'months_ahead must be >= 0, got %', months_ahead;
  END IF;

  SELECT n.nspname, c.relname INTO parent_ns, parent_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.oid = target;

  -- Refuse a plain table outright. Silently doing nothing here would let a half-finished conversion look
  -- maintained: the sweep would report success every day for a table that has no partitions at all.
  IF (SELECT relkind FROM pg_class WHERE oid = target) <> 'p' THEN
    RAISE EXCEPTION '% is not a partitioned table', target;
  END IF;

  FOR i IN 0..months_ahead LOOP
    month_start := date_trunc('month', CURRENT_DATE)::date + make_interval(months => i);
    part_name   := format('%s_%s', parent_name, to_char(month_start, 'YYYY_MM'));

    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = part_name AND n.nspname = parent_ns
    );

    -- The bound is [month, next month) — half-open, so consecutive months cannot overlap and no timestamp
    -- falls between two partitions.
    EXECUTE format(
      'CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
      parent_ns, part_name, parent_ns, parent_name,
      month_start, (month_start + interval '1 month')::date
    );
    created := created + 1;
  END LOOP;

  RETURN created;
END;
$$ LANGUAGE plpgsql;

-- Owner-only on purpose. Creating a table is DDL: the tenant-facing role must never hold it, and this runs
-- from the leader-locked sweep on the privileged connection.
REVOKE ALL ON FUNCTION ensure_month_partitions(regclass, int) FROM PUBLIC;
