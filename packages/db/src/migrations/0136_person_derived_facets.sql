-- 0136_person_derived_facets.sql — the three DERIVED person facets the Phase-1 gap analysis classified as
-- "derivable, needs materialization" (search-consolidation stage 5). [S-13][S-09]
--
-- WHY COLUMNS AND NOT QUERY-TIME EXPRESSIONS. Each of these is an aggregate or a lookup over a raw value:
--   • job function is a taxonomy lookup on job_title;
--   • career start is min(started_on) across every stint;
--   • current-role start is the PRIMARY stint's started_on.
-- Computed per row at query time none of them is indexable, so a filter on them degrades to a scan of the
-- whole visible population — which is exactly the failure the trgm work exists to avoid. Materializing them
-- makes the filters index-backed; the cost is that a writer must keep them fresh (landSourcePayload does,
-- inside the same transaction that writes the stints they derive from).
--
-- EXPAND ONLY and ADDITIVE. All three columns are NULLABLE and start NULL, so every existing read is
-- byte-identical until a writer populates them. NULL means "not derived yet" and never "zero" — see the
-- sentinel note below, which is the whole reason these are not a simple min().
--
-- THE '-infinity' SENTINEL. master_employment.started_on defaults to '-infinity', meaning "start unknown"
-- (it exists so the dedup unique (person, company, started_on) collides for unknown starts). It is NOT a
-- date. A naive min(started_on) returns it for anyone with one undated stint, and the resulting "years of
-- experience" is roughly two thousand. Both the backfill below and the landing writer exclude it explicitly,
-- and the itest pins that a sentinel-only person derives NULL rather than a number.
--
-- The index builds are CONCURRENTLY (one statement per breakpoint, marker never quoted in this file); the
-- ALTERs are not — adding a NULLABLE column with no default is a catalog-only change in Postgres 11+, so it
-- takes a brief ACCESS EXCLUSIVE lock and rewrites nothing.

ALTER TABLE master_persons
  ADD COLUMN IF NOT EXISTS title_function varchar(30),
  ADD COLUMN IF NOT EXISTS career_started_on date,
  ADD COLUMN IF NOT EXISTS primary_started_on date;
--> statement-breakpoint

COMMENT ON COLUMN master_persons.title_function IS
  'DERIVED from job_title via the core title taxonomy (packages/types titleFunction). NULL = the title did not resolve, which is a legitimate gap, not an error.';
--> statement-breakpoint
COMMENT ON COLUMN master_persons.career_started_on IS
  'DERIVED: earliest master_employment.started_on EXCLUDING the ''-infinity'' unknown-start sentinel. NULL = no dated stint. Powers years-of-experience.';
--> statement-breakpoint
COMMENT ON COLUMN master_persons.primary_started_on IS
  'DERIVED: the PRIMARY stint''s started_on, sentinel excluded. NULL = unknown. Powers years-in-role and recent-job-change (S-13).';
--> statement-breakpoint

-- One-time backfill for rows that already exist. Bounded by the visible population and run once; the
-- landing writer keeps it fresh from here on. Sentinel excluded in BOTH aggregates — that exclusion is the
-- correctness of this statement, not a detail of it.
UPDATE master_persons p
   SET career_started_on = agg.career_start,
       primary_started_on = agg.primary_start
  FROM (
    SELECT e.master_person_id,
           min(e.started_on) FILTER (WHERE e.started_on <> '-infinity'::date) AS career_start,
           min(e.started_on) FILTER (WHERE e.is_primary AND e.started_on <> '-infinity'::date) AS primary_start
      FROM master_employment e
     GROUP BY e.master_person_id
  ) agg
 WHERE agg.master_person_id = p.id
   AND (p.career_started_on IS DISTINCT FROM agg.career_start
        OR p.primary_started_on IS DISTINCT FROM agg.primary_start);
--> statement-breakpoint

-- title_function is deliberately NOT backfilled here. The mapping lives in the core title taxonomy
-- (TypeScript), not in SQL, and duplicating it as a CASE expression would create a second implementation
-- that drifts from the first — the failure mode this codebase has already paid for elsewhere. It is
-- populated by the landing writer, and by masterPersonDerivedRepository.backfillTitleFunctionTx for the
-- existing rows (an operator-invoked bounded sweep, not a new queue).

SET statement_timeout = 0;
--> statement-breakpoint

-- Partial on MASTER_PERSON_VISIBLE, matching 0123/0135 — keep byte-identical or the planner stops using them.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_persons_visible_title_function
  ON master_persons (title_function)
  WHERE visibility IN ('licensed','coop') AND is_suppressed = false AND merged_into_person_id IS NULL;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_persons_visible_career_start
  ON master_persons (career_started_on)
  WHERE visibility IN ('licensed','coop') AND is_suppressed = false AND merged_into_person_id IS NULL;
--> statement-breakpoint
-- DESC because the question is always "changed job RECENTLY" (S-13) — the newest rows first.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_persons_visible_primary_start
  ON master_persons (primary_started_on DESC)
  WHERE visibility IN ('licensed','coop') AND is_suppressed = false AND merged_into_person_id IS NULL;
--> statement-breakpoint

SET statement_timeout = '120s';

-- DOWN (manual; forward-only project): DROP the three indexes CONCURRENTLY. Do NOT drop the columns — the
-- rollback for an additive nullable column is to stop reading it (the feature gate), never a destructive
-- migration.
