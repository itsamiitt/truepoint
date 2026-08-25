-- 0140_partition_rls.sql — close a cross-tenant read: RLS does NOT propagate to partitions.
--
-- THE BUG. PostgreSQL applies the row-security policies of the table NAMED IN THE QUERY. Querying a
-- partitioned parent applies the parent's policies to every partition it touches, which is why
-- `SELECT ... FROM activities` has always been correctly workspace-scoped. But a partition is itself a table,
-- and `CREATE TABLE ... PARTITION OF` does not inherit `relrowsecurity` from its parent. Naming the partition
-- directly therefore applies NO policy at all, and `leadwolf_app` holds SELECT/INSERT/UPDATE/DELETE on every
-- partition through the schema-wide grant. Reproduced against a migrated database, as leadwolf_app with
-- workspace A's GUC set:
--
--     SELECT note FROM activities;            -- A-secret                (policy enforced)
--     SELECT note FROM activities_2026_08;    -- A-secret, B-secret      (another tenant's row)
--
-- Nothing in apps/ or packages/ names a partition directly today, so this is a latent hole rather than a
-- live leak — but the only thing standing between it and a real one is that no one has written the query
-- yet, and "no caller has done the unsafe thing yet" is not tenant isolation. access-control.md states the
-- invariant plainly: every tenant-owned table has RLS. A partition is a tenant-owned table.
--
-- THE FIX, AND WHY IT CARRIES NO POLICY. Enabling RLS on a partition with NO policy denies every non-owner
-- row access to it, which is exactly the intent: nothing should reach a partition by name. Parent-routed
-- access is untouched, because the parent's policies are what govern it. All four states were measured on a
-- migrated database before this was written:
--
--     partition state              SELECT via parent     SELECT naming the partition
--     baseline (no RLS)            A-secret              A-secret, B-secret   <- the leak
--     ENABLE, no policy            A-secret              (none)               <- what we now do
--     ENABLE + FORCE + policy      A-secret              A-secret
--
-- and an INSERT through the parent as leadwolf_app still succeeds with partition RLS in place. The
-- no-policy form is chosen over copying the parent's policy onto each partition because a copied policy is a
-- second definition of the same rule that has to be kept in step with the first, every month, for ever —
-- and the copy that drifts is the one nobody notices. There is nothing to keep in sync here.
--
-- ENABLE WITHOUT FORCE, deliberately, matching the idiom this repo already documents on platform_audit_log
-- ("RLS still ENABLED (not FORCED — the owner is the withPlatformTx writer) with no policy, which is what
-- denies leadwolf_app every row"). The owner still reaches partitions for maintenance; the tenant-facing
-- role does not. FORCE would additionally block any owner-run row-level maintenance, which is a cost with
-- no matching benefit — the app role is the boundary that matters.

-- WHAT LIVES WHERE. The catalog sweep that fixes the partitions which ALREADY exist is NOT here — it is
-- packages/db/src/rls/zzPartitionInheritance.sql. It cannot be here: migrations run in step [2/4] and the RLS
-- files in [3/4], so a migration asking "which parents have relrowsecurity?" runs before any parent has it,
-- matches zero rows, and reports success. The first draft of this file did exactly that and silently fixed
-- nothing. What belongs here is the FUNCTION, because a function body is evaluated when it is CALLED — from
-- the leader-locked sweep, long after RLS is in place — so the same catalog question is answered correctly.

-- ── Future partitions ──────────────────────────────────────────────────────────────────────────────────────
-- Fixing only the existing partitions would fix this until the next calendar month. ensure_month_partitions
-- runs from the leader-locked sweep and creates months ahead; every partition it created before today was
-- born without RLS. The CREATE now enables it in the same statement sequence, so a partition cannot exist in
-- the unprotected state even briefly.
--
-- Unchanged from 0084 apart from that: same signature, same idempotence, same refusal to touch a plain table,
-- same half-open [month, next month) bounds. Reproduced in full because CREATE OR REPLACE FUNCTION has no
-- partial form.
CREATE OR REPLACE FUNCTION ensure_month_partitions(target regclass, months_ahead int DEFAULT 3)
RETURNS int AS $$
DECLARE
  parent_ns   text;
  parent_name text;
  parent_rls  boolean;
  part_name   text;
  month_start date;
  created     int := 0;
  i           int;
BEGIN
  IF months_ahead < 0 THEN
    RAISE EXCEPTION 'months_ahead must be >= 0, got %', months_ahead;
  END IF;

  SELECT n.nspname, c.relname, c.relrowsecurity INTO parent_ns, parent_name, parent_rls
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

    -- A partition of a tenant-scoped parent is itself tenant-scoped. RLS is not inherited (0140), so it is
    -- set here, at birth, rather than by a sweep that would have to notice the gap first.
    IF parent_rls THEN
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', parent_ns, part_name);
    END IF;

    created := created + 1;
  END LOOP;

  RETURN created;
END;
$$ LANGUAGE plpgsql;

-- Owner-only on purpose. Creating a table is DDL: the tenant-facing role must never hold it, and this runs
-- from the leader-locked sweep on the privileged connection.
REVOKE ALL ON FUNCTION ensure_month_partitions(regclass, int) FROM PUBLIC;
