-- 0102_partition_acl_inherit.sql — make a newly created monthly partition inherit its PARENT's privileges
-- instead of the schema-wide default grant.
--
-- THE GAP THIS CLOSES (found while adding the second partitioned table, 0101)
-- Partition ACLs are INDEPENDENT of the parent's in Postgres. Privileges are checked on the relation actually
-- named in a query, so `REVOKE ALL ON provenance_event FROM leadwolf_app` correctly blocks
-- `SELECT ... FROM provenance_event` — but it says nothing about `SELECT ... FROM provenance_event_2026_08`.
-- Meanwhile applyMigrations.ts GRANTS carries:
--     ALTER DEFAULT PRIVILEGES IN SCHEMA public
--       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO leadwolf_app;
-- and a partition is an ordinary table in `public`, created by ensure_month_partitions on the privileged
-- connection. So every month the sweep minted a partition of a REVOKE'd Layer-0 table, that partition was
-- granted to the customer app role and was directly readable BY NAME. Partition names are entirely
-- predictable (parent_YYYY_MM — this function builds them).
--
-- This is PRE-EXISTING and already affects `provenance_event`, whose partitions do not even match the
-- `^master_` convention loop in GRANTS and so were never swept up by it either. It is not introduced by
-- 0101; 0101 is what made it visible.
--
-- WHY MIRROR THE PARENT RATHER THAN BLANKET-REVOKE
-- Not every partitioned table is Layer-0. A tenant-scoped, RLS-protected partitioned table legitimately needs
-- leadwolf_app privileges, and a blanket `REVOKE ALL FROM leadwolf_app` inside this function would break it
-- the first time such a table is converted — silently, on a calendar boundary, which is the worst possible
-- failure shape. Mirroring the parent is correct for BOTH cases and needs no list of table names to maintain:
-- whatever the parent grants, the partition grants; whatever the parent withholds, the partition withholds.
--
-- The owner is deliberately excluded from the revoke sweep: ownership privileges are not the thing at risk,
-- and revoking from the owner mid-function is how a maintenance job locks itself out.
--
-- EXPAND ONLY / behaviour-preserving for existing tables: this replaces the function body. It creates the
-- same partitions with the same bounds and the same idempotency; the only change is the ACL applied
-- afterwards. Existing partitions are re-aligned by the backfill at the bottom, which is a privilege change,
-- not a data change.

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

    -- Make the new partition's privileges match the parent's, undoing the schema-wide default grant it just
    -- picked up. Called immediately after CREATE so there is no window in which the partition is readable by
    -- a role the parent denies.
    PERFORM mirror_partition_acl(parent_ns, part_name, target);

    created := created + 1;
  END LOOP;

  RETURN created;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Set `child`'s ACL to exactly `parent`'s: strip every non-owner grantee the child picked up, then re-grant
-- whatever the parent grants. Separated from ensure_month_partitions so it can also be applied to partitions
-- that already exist (the backfill below) and asserted directly by an isolation test.
CREATE OR REPLACE FUNCTION mirror_partition_acl(child_ns text, child_name text, parent regclass)
RETURNS void AS $$
DECLARE
  child_oid  oid;
  owner_oid  oid;
  r          record;
BEGIN
  SELECT c.oid, c.relowner INTO child_oid, owner_oid
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relname = child_name AND n.nspname = child_ns;

  IF child_oid IS NULL THEN
    RAISE EXCEPTION 'partition %.% not found', child_ns, child_name;
  END IF;

  -- 1. Strip what the child currently grants to anyone who is not its owner. PUBLIC (grantee 0) is revoked
  --    explicitly because it never appears as a role name.
  EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC', child_ns, child_name);
  -- pg_get_userbyid, not grantee::regrole::text: regrole's output is ALREADY quoted when the role name needs
  -- it, so passing it through %I would double-quote and produce an invalid statement. %I must receive the
  -- raw name and do the quoting itself.
  FOR r IN
    SELECT DISTINCT pg_get_userbyid(a.grantee) AS role_name
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.oid = child_oid AND a.grantee <> 0 AND a.grantee <> owner_oid
  LOOP
    EXECUTE format('REVOKE ALL ON %I.%I FROM %I', child_ns, child_name, r.role_name);
  END LOOP;

  -- 2. Re-grant exactly what the parent grants. A parent with a NULL relacl (owner-only, the default) yields
  --    no rows here, which is the correct outcome: the partition ends up owner-only too.
  FOR r IN
    SELECT pg_get_userbyid(a.grantee) AS role_name,
           string_agg(DISTINCT a.privilege_type, ', ') AS privs
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.oid = parent AND a.grantee <> 0 AND a.grantee <> owner_oid
     GROUP BY a.grantee
  LOOP
    -- privs is a catalog-derived privilege list (SELECT, INSERT, …), never user input, so it interpolates
    -- as %s: %I would quote the whole comma-separated list into one bogus identifier.
    EXECUTE format('GRANT %s ON %I.%I TO %I', r.privs, child_ns, child_name, r.role_name);
  END LOOP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Owner-only, for the same reason ensure_month_partitions is: this hands out privileges.
REVOKE ALL ON FUNCTION mirror_partition_acl(text, text, regclass) FROM PUBLIC;
--> statement-breakpoint

-- BACKFILL: re-align every partition that already exists. Idempotent — running it on an already-correct
-- partition revokes and re-grants the same set. Privilege change only; no data is read, written, or moved.
DO $$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT cn.nspname AS child_ns, ch.relname AS child_name, i.inhparent AS parent_oid
      FROM pg_inherits i
      JOIN pg_class ch ON ch.oid = i.inhrelid
      JOIN pg_namespace cn ON cn.oid = ch.relnamespace
      JOIN pg_class pa ON pa.oid = i.inhparent
     WHERE pa.relkind = 'p' AND cn.nspname = 'public'
  LOOP
    PERFORM mirror_partition_acl(p.child_ns, p.child_name, p.parent_oid::regclass);
  END LOOP;
END $$;

-- DOWN (manual): restore the 0084 body of ensure_month_partitions and
--   DROP FUNCTION mirror_partition_acl(text, text, regclass);
-- Note this would REOPEN the gap described in the header — it is a rollback of a security fix, not a
-- neutral revert.
