-- 0114_master_company_headcount.sql — the Layer-0 monthly headcount time series [S-09][S-13][S-10][A-01]
-- (HAND-AUTHORED: PARTITION BY HASH is not expressible by drizzle-kit; schema/masterHeadcount.ts is kept
-- OUT of schema/index.ts so generate never emits competing DDL — the masterSignals/masterEducation pattern).
--
-- WHY HASH(master_company_id), 32 static partitions — and NOT the 0103 RANGE-on-observed_at shape:
--   1. UPSERT table. Dedup identity = (company, month, job_function); a partitioned unique must include the
--      partition key, so RANGE on observed_at would degrade "one row per month" into "one row per refetch"
--      (the 0085 trap). HASH on company keeps the identity exact.
--   2. RANGE on month is blocked by operational reality: ensure_month_partitions (0102) creates partitions
--      FORWARD only, and every FIRST fetch of a company carries ~24 months of history — the backfill would
--      land in DEFAULT and permanently block later partition creation (0103's own header warning).
--   3. Every hot read is per-company → hash pruning = single-partition reads; refetch upserts touch one
--      partition; no time-based retention applies. The "who grew this month" feed reads master_signals
--      (fact + event, the master_company_funding precedent), never scans this table.
--
-- Growth windows / change_pct are NOT stored (no-rollup rule) — lag() over ≤25 rows per company at read
-- time; the vendor's growth block survives verbatim in source_records.raw_data.
--
-- ACL: parent + partitions all match the ^master_ REVOKE convention loop; leadwolf_er's grant lands on the
-- PARENT in applyMigrations.ts (routed DML checks parent privileges); mirror_partition_acl (0102) runs at
-- the end of the grants block each migrate as the belt for direct-partition access. Partitions created HERE
-- inherit the parent's ACL at CREATE TABLE ... PARTITION OF time only if the parent's grants exist, which
-- at migration time they do NOT (grants run after migrations) — the convention loop + parent grant converge
-- everything on the same migrate run, and the itest asserts partition-by-name denial.

CREATE TABLE IF NOT EXISTS master_company_headcount (
  id                uuid NOT NULL DEFAULT uuid_generate_v7(),
  master_company_id uuid NOT NULL REFERENCES master_companies(id) ON DELETE CASCADE,
  month             date NOT NULL,
  job_function      varchar(60) NOT NULL DEFAULT '',
  employee_count    integer NOT NULL,
  source_name       varchar(50) NOT NULL,
  observed_at       timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- The composite PK IS the upsert target and includes the hash partition key. `id` stays a stable
  -- row handle for tooling but deliberately not the PK.
  CONSTRAINT master_company_headcount_pk PRIMARY KEY (master_company_id, month, job_function),
  CONSTRAINT master_company_headcount_month_canonical CHECK (month = date_trunc('month', month)::date),
  CONSTRAINT master_company_headcount_count_nonneg CHECK (employee_count >= 0)
) PARTITION BY HASH (master_company_id);
--> statement-breakpoint
DO $$
DECLARE i int;
BEGIN
  FOR i IN 0..31 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS master_company_headcount_p%s PARTITION OF master_company_headcount
         FOR VALUES WITH (MODULUS 32, REMAINDER %s)',
      lpad(i::text, 2, '0'), i
    );
  END LOOP;
END $$;
--> statement-breakpoint
-- The totals sparkline/latest read: per-company, newest-first, whole-company rows only ('' = total),
-- covering employee_count for index-only scans. Partitioned parent index → cascades to every partition.
-- BRIN was considered and rejected: overlapping refetches destroy month/physical-order correlation.
CREATE INDEX IF NOT EXISTS idx_master_company_headcount_totals
  ON master_company_headcount (master_company_id, month DESC) INCLUDE (employee_count)
  WHERE job_function = '';
--> statement-breakpoint
-- The dated-EVENT vocabulary for the series (fact + signal, the funding precedent): a directional pair in
-- the existing 'hiring' family, mirroring tech_adopted/tech_removed and exec_hired/exec_departed. Emission
-- is thresholded in core (HEADCOUNT_SIGNAL_MIN_PCT) — the samples show endless ±0% months, and an
-- unthresholded emitter would be pure noise.
INSERT INTO master_signal_types (code, family, label, default_weight, half_life_days) VALUES
  ('headcount_surge',   'hiring', 'Headcount growing',   5, 120),
  ('headcount_decline', 'hiring', 'Headcount shrinking', 5, 120)
ON CONFLICT (code) DO NOTHING;

-- DOWN (manual — safe while the linkedin_api landing flag is off):
--   DROP TABLE master_company_headcount CASCADE;
--   DELETE FROM master_signal_types WHERE code IN ('headcount_surge','headcount_decline');
