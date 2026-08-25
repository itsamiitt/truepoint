-- zzPartitionInheritance.sql — RLS does not propagate to partitions. Give every partition of a tenant-scoped
-- parent its own ENABLE, so naming a partition directly cannot walk around the parent's policy.
--
-- THE HOLE THIS CLOSES. PostgreSQL applies the row-security policies of the table NAMED IN THE QUERY.
-- Querying a partitioned parent applies the parent's policies to the partitions it touches — which is why
-- `SELECT ... FROM activities` has always been correctly workspace-scoped. A partition is itself a table, and
-- `CREATE TABLE ... PARTITION OF` does not inherit `relrowsecurity`. Naming one directly applied NO policy,
-- and `leadwolf_app` holds table privileges on every partition via the schema-wide grant in step [4/4].
-- Measured against a migrated database, as leadwolf_app with workspace A's GUC set:
--
--     SELECT note FROM activities;            -- A-secret               (policy enforced)
--     SELECT note FROM activities_2026_08;    -- A-secret, B-secret     (another tenant's row)
--
-- WHY THIS IS AN RLS FILE AND NOT A MIGRATION. It has to be — and the first draft of it was a migration,
-- which silently did nothing. Migrations run in step [2/4]; these RLS files run in [3/4]. A migration asking
-- "which parents have relrowsecurity?" runs BEFORE any parent has it, matches zero rows, and reports success.
-- Here every parent's own file has already run, so the catalog answer is the real one. It is also the right
-- home on the merits: these files are declared idempotent and re-run on every migrate, which is exactly what
-- a catalog-driven sweep wants.
--
-- NO POLICY, DELIBERATELY. Enabling RLS with no policy denies every non-owner row access to the partition,
-- which is the whole intent: nothing should reach a partition by name. Parent-routed reads and writes are
-- unaffected, because the parent's policies govern those. Measured, all three states:
--
--     partition state              SELECT via parent     SELECT naming the partition
--     baseline (no RLS)            A-secret              A-secret, B-secret   <- the hole
--     ENABLE, no policy            A-secret              (none)               <- this file
--     ENABLE + FORCE + policy      A-secret              A-secret
--
-- The no-policy form is chosen over copying each parent's policy onto its partitions because a copied policy
-- is a second definition of the same rule that must be kept in step with the first, for every partition,
-- every month, for ever — and the copy that drifts is the one nobody notices.
--
-- ENABLE WITHOUT FORCE, matching the idiom this repo already documents on platform_audit_log ("RLS still
-- ENABLED (not FORCED — the owner is the withPlatformTx writer) with no policy, which is what denies
-- leadwolf_app every row"). The owner keeps its maintenance reach; the tenant-facing role does not. FORCE
-- would additionally block owner-run row-level maintenance — a cost with no matching benefit, since the app
-- role is the boundary that matters here.
--
-- SORTS LAST ON PURPOSE. applyMigrations reads this folder with a plain `.sort()`, so the `zz` prefix is what
-- guarantees every parent's RLS file has run before this one reads the catalog. A name like `partitions.sql`
-- would sort ahead of provenance/usageEvents/verificationJobs and silently miss exactly those parents.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT child_ns.nspname AS ns, child.relname AS name, parent.relname AS parent
      FROM pg_inherits inh
      JOIN pg_class child        ON child.oid  = inh.inhrelid
      JOIN pg_class parent       ON parent.oid = inh.inhparent
      JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
     WHERE parent.relkind = 'p'
       AND parent.relrowsecurity          -- the parent is tenant-scoped …
       AND child.relkind = 'r'
       AND NOT child.relrowsecurity       -- … and this partition is not. Re-runs match nothing.
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.ns, r.name);
    RAISE NOTICE 'partition RLS enabled: %.% (partition of %)', r.ns, r.name, r.parent;
  END LOOP;
END;
$$;
