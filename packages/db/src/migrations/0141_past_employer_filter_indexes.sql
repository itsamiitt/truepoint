-- 0141_past_employer_filter_indexes.sql — the reverse-lookup indexes behind the "worked at X" people
-- filter (search-consolidation stage 4, phase 3d). [S-09]
--
-- WHAT WAS MISSING AND WHY IT MATTERS. Every existing index over master_employment is keyed by
-- master_person_id, because until now every reader was: profile reads, the job-change sweep, DSAR, the
-- derived-facet recompute. "Which PEOPLE worked at this company" is the opposite direction, and nothing
-- served it:
--
--   • idx_employment_company is PARTIAL on `WHERE is_current` — and its own schema comment says
--     "Admin/recompute/cursor scans ONLY — never the OLTP hot path". A "has ever worked at X" filter is
--     precisely the past-stint case that partial excludes, so it fell to a sequential scan of the edge
--     table on every query.
--   • idx_employment_unresolved is PARTIAL on `master_company_id IS NULL`, so matching an employer by
--     NAME over stints that DID resolve had no index either.
--   • master_companies.name_normalized has no index at all — deliberately deferred (masterGraph.ts:62,
--     "scale-track/ER-blocking only"). The filter's company-id leg resolves a name through that column,
--     so the deferral ends here.
--
-- WHY BOTH LEGS EXIST (and so both indexes). The live import path mints a BARE employment edge carrying
-- only (person, company, is_current, is_primary) — no company_name_normalized at all — so a name-only
-- match would miss most stints in the graph. A stint whose employer ER never resolved carries the reverse:
-- a normalized name and no company id. The filter matches either, so each needs its own access path.
--
-- The trailing master_person_id on the employment indexes is what keeps the EXISTS an index-only probe:
-- the correlated subquery tests person membership, so having the person id in the index avoids a heap
-- fetch per candidate row.
--
-- EXPAND ONLY, hand-authored per the 0109/0132/0135 posture: drizzle-kit emits only plain blocking
-- CREATE INDEX, and these must be CONCURRENTLY on tables sized (masterGraph.ts:249) for billions of rows.
-- CONCURRENTLY is safe in this migrator: applyMigrations.ts runs each statement separately in AUTOCOMMIT.
-- The invalid-leftover sweep exists because a failed CONCURRENTLY build leaves an INVALID index that the
-- already-exists tolerance would skip past forever.

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
       AND c.relname IN ('idx_employment_company_person',
                         'idx_employment_name_person',
                         'idx_master_companies_name_normalized')
  LOOP
    EXECUTE format('DROP INDEX CONCURRENTLY IF EXISTS public.%I', r.relname);
  END LOOP;
END $$;
--> statement-breakpoint

-- Long index builds must not be killed by the migration timeout.
SET statement_timeout = 0;
--> statement-breakpoint

-- ── The company-id leg: resolved stints, INCLUDING past ones (unpartial, unlike idx_employment_company) ──
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_employment_company_person
  ON master_employment (master_company_id, master_person_id)
  WHERE master_company_id IS NOT NULL;
--> statement-breakpoint

-- ── The name leg: stints ER never resolved, which carry a normalized name and no company id ─────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_employment_name_person
  ON master_employment (company_name_normalized, master_person_id)
  WHERE company_name_normalized IS NOT NULL;
--> statement-breakpoint

-- ── Resolving the typed employer NAME to a company id (the deferral this filter ends) ───────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_companies_name_normalized
  ON master_companies (name_normalized)
  WHERE name_normalized IS NOT NULL;
