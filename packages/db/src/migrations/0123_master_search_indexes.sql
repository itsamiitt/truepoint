-- 0123_master_search_indexes.sql — index the global DATABASE search over Layer-0 [S-09][S-13][S-10]
-- (docs/planning: Layer-0 as THE product database, D10). HAND-AUTHORED — the 0081 pattern verbatim: every
-- CREATE INDEX is CONCURRENTLY (no ACCESS EXCLUSIVE lock on the shared graph), so each is the ONLY statement
-- in its batch (one per breakpoint marker; the marker is never quoted in this file), and the migration
-- timeout is lifted for the builds. IF NOT EXISTS makes it re-runnable; an INVALID leftover from a failed
-- CONCURRENTLY build must be dropped by name and the file re-run.
--
-- DECISION SURFACED (rule 6): masterGraph.ts's header deferred these GINs to an OpenSearch/engine adapter.
-- The operator's product decision makes Postgres the global read path NOW; the trgm indexes are the price.
-- They are PARTIAL on the visible predicate, so they index only the licensed/co-op, unsuppressed, unmerged
-- rows the search may return — the mint-only private population (workspace imports) costs nothing here.
-- Kill date: when a search engine adapter takes over the database scope, drop these.

SET statement_timeout = 0;
--> statement-breakpoint
-- Keyset + count path: (created_at DESC, linkedin_public_id DESC) is the cursor order.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_persons_visible_keyset
  ON master_persons (created_at DESC, linkedin_public_id DESC)
  WHERE visibility IN ('licensed','coop') AND is_suppressed = false AND merged_into_person_id IS NULL;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_persons_visible_slug
  ON master_persons (linkedin_public_id)
  WHERE visibility IN ('licensed','coop') AND is_suppressed = false AND merged_into_person_id IS NULL;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_persons_trgm_full_name
  ON master_persons USING gin (full_name gin_trgm_ops)
  WHERE visibility IN ('licensed','coop') AND is_suppressed = false AND merged_into_person_id IS NULL;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_persons_trgm_job_title
  ON master_persons USING gin (job_title gin_trgm_ops)
  WHERE visibility IN ('licensed','coop') AND is_suppressed = false AND merged_into_person_id IS NULL;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_persons_trgm_location_raw
  ON master_persons USING gin (location_raw gin_trgm_ops)
  WHERE visibility IN ('licensed','coop') AND is_suppressed = false AND merged_into_person_id IS NULL;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_persons_visible_seniority
  ON master_persons (seniority_level)
  WHERE visibility IN ('licensed','coop') AND is_suppressed = false AND merged_into_person_id IS NULL;
--> statement-breakpoint
-- Company name leg of the text OR + the company term filter (joined via current_company_id).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_companies_trgm_name
  ON master_companies USING gin (name gin_trgm_ops);
