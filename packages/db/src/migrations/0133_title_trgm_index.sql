-- 0133_title_trgm_index.sql — trgm GIN for the title filter's contains-match leg (launch-scale Phase 2,
-- finding F3). [S-02][S-10]
--
-- EXPAND ONLY, hand-authored per the 0109/0132 posture (drizzle-kit emits only plain blocking CREATE INDEX;
-- this must be CONCURRENTLY on the hottest table). Verified missing against all CREATE INDEX statements in
-- migrations 0000–0132 AND the Drizzle schema defs: 0132 indexed the department/location ILIKE legs and the
-- enum-ish term filters, but job_title — the single most-used term filter (clauseCondition "title") — was
-- missed. Measured against an 8.25M-contact seed (500k-contact workspace): `title ILIKE '%engineer%'` +
-- seniority planned as a heap Filter that fetched 282,426 rows via idx_contacts_ws_seniority and discarded
-- 239,973, and the resulting rows=1 misestimate flipped the suppression anti-join into its pathological
-- nested-loop regime (searchRepository.ts NOT_SUPPRESSED regime analysis). The trgm GIN gives the ILIKE leg
-- index-driven candidates, exactly as 0081 did for email_domain and 0132 for department/location.
--
-- CONCURRENTLY is safe in this migrator: applyMigrations.ts runs each statement separately in AUTOCOMMIT
-- (0106/0109 document this). The invalid-leftover sweep exists for the same reason as 0109's/0132's: a
-- failed CONCURRENTLY build leaves an INVALID index the already-exists tolerance would skip past forever.

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND NOT i.indisvalid
       AND c.relname = 'idx_contacts_trgm_job_title'
  LOOP
    EXECUTE format('DROP INDEX CONCURRENTLY IF EXISTS public.%I', r.relname);
  END LOOP;
END $$;
--> statement-breakpoint

-- Long index builds must not be killed by the migration timeout.
SET statement_timeout = 0;
--> statement-breakpoint

-- (pg_trgm is already installed by 0081; leading-wildcard ILIKE is exactly what this accelerates.)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_trgm_job_title
  ON contacts USING gin (job_title gin_trgm_ops);

-- DOWN (manual; forward-only project): DROP INDEX CONCURRENTLY IF EXISTS idx_contacts_trgm_job_title.
-- Safe for correctness, costly for performance: the title filter reverts to a workspace heap scan.
