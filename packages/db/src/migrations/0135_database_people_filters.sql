-- 0135_database_people_filters.sql — index the People-side global filters the search-consolidation stage-4
-- work exposes (docs/planning/search-consolidation/03-migration-and-index-plan.md). [S-04][S-09][S-10]
--
-- HAND-AUTHORED, the 0123/0132/0133/0134 pattern verbatim: every CREATE INDEX is CONCURRENTLY (no ACCESS
-- EXCLUSIVE lock on the shared graph), so each is the ONLY statement in its batch — one per breakpoint
-- marker, and that marker string is never quoted anywhere in this file, because applyMigrations splits on it
-- literally. IF NOT EXISTS makes the file re-runnable; the sweep drops an INVALID leftover first, since a
-- failed CONCURRENTLY build leaves one that IF NOT EXISTS would skip past forever.
--
-- EXPAND ONLY. No column is dropped, renamed or retyped; no data is touched.
--
-- The master_persons indexes are PARTIAL on MASTER_PERSON_VISIBLE — the predicate in
-- masterPersonReadRepository.ts, and the same one 0123's indexes use:
--
--     visibility IN ('licensed','coop') AND is_suppressed = false AND merged_into_person_id IS NULL
--
-- Keep them byte-identical or the planner stops using them. The EDGE tables (phones, skills, languages,
-- education, employment) are NOT partial: the predicate lives on master_persons, not on them, so a partial
-- index there could not be proven to apply. They are reached through a join from an already-filtered person.

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
       AND c.relname IN ('idx_master_persons_visible_company',
                         'idx_master_phones_person_line_type',
                         'idx_master_person_skills_skill',
                         'idx_master_person_languages_name',
                         'idx_master_education_school_norm',
                         'idx_master_education_fields_gin',
                         'idx_master_employment_person_started')
  LOOP
    EXECUTE format('DROP INDEX CONCURRENTLY IF EXISTS public.%I', r.relname);
  END LOOP;
END $$;
--> statement-breakpoint

-- Long index builds must not be killed by the migration timeout.
SET statement_timeout = 0;
--> statement-breakpoint

-- The employer join. Every people query that filters on a COMPANY trait (industry, name, headcount) reaches
-- master_companies through current_company_id, and that column had no index at all — so the join drove from
-- the company side and filtered persons by heap lookup.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_persons_visible_company
  ON master_persons (current_company_id)
  WHERE visibility IN ('licensed','coop') AND is_suppressed = false AND merged_into_person_id IS NULL;
--> statement-breakpoint

-- Mobile vs direct-dial (S-04). The profile read and the has_mobile facet are an EXISTS over this table
-- keyed by person and filtered by line_type; without the composite it is a per-person heap scan of every
-- phone row that person has.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_phones_person_line_type
  ON master_phones (master_person_id, line_type);
--> statement-breakpoint

-- The attribute EXISTS filters. skill/name are CITEXT, which is fine for an equality/prefix btree — this is
-- NOT the trgm case, so no ::text cast is needed or wanted here (contrast 0081/0134, where a leading-wildcard
-- ILIKE forced the expression form).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_person_skills_skill
  ON master_person_skills (skill);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_person_languages_name
  ON master_person_languages (name);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_education_school_norm
  ON master_education (school_name_normalized);
--> statement-breakpoint
-- fields_of_study is text[]; a GIN is what serves the containment/overlap operators.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_education_fields_gin
  ON master_education USING gin (fields_of_study);
--> statement-breakpoint

-- The PRIMARY stint's start date — the source for years-in-role and "changed job in the last N days"
-- (S-13), and what the profile drawer orders employment by. Partial on is_primary because that is the only
-- row those questions read; the index stays roughly one row per person rather than one per stint.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_employment_person_started
  ON master_employment (master_person_id, started_on)
  WHERE is_primary = true;
--> statement-breakpoint

SET statement_timeout = '120s';

-- DOWN (manual; forward-only project): DROP INDEX CONCURRENTLY IF EXISTS for each index above. Safe for
-- correctness, costly for performance — each filter reverts to a scan.
