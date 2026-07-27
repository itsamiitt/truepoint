-- 0081_search_trgm_indexes.sql — make Postgres text search INDEX-SERVED (S-4.1).
--
-- HAND-AUTHORED (drizzle-kit generate is forbidden here — expression and operator-class indexes are not
-- expressible through the schema DSL without drift).
--
-- The problem: free-text search is a 6-leg `ILIKE '%…%'` OR, and title filters expand synonyms into N more
-- `%…%` patterns per query. A leading wildcard makes a btree index useless, and one of the legs is an
-- unindexable concat EXPRESSION. Across all 80 prior migrations there is no trgm or tsvector index at all, so
-- every search, every facet count and every typeahead was a full scan of the workspace's contacts.
--
-- pg_trgm's GIN indexes are built precisely for this: they accelerate LIKE/ILIKE *with* leading wildcards.
-- This is therefore a pure speedup — the queries are untouched and match exactly what they matched before.
--
-- DELIBERATELY NOT INCLUDED: the `tsvector` + `websearch_to_tsquery` half of S-4.1. That is not a speedup, it
-- is a change of MEANING — `ILIKE '%eng%'` matches "Engineering", a tsquery does not. Switching substring
-- matching to word matching alters which contacts a saved search returns, so it belongs with the S-4.2 search
-- redesign and a deliberate product decision, not with an index migration.
--
-- STOPGAP WITH A KILL DATE. This makes the interim Postgres search survivable; it is not a substitute for the
-- real search backend (S-4.2). Trigram indexes are large and write-amplifying, so when the Typesense adapter
-- lands, these should be dropped rather than left to cost write throughput forever.
--
-- Every CREATE INDEX is CONCURRENTLY (no ACCESS EXCLUSIVE lock on a hot table), which means each must be the
-- ONLY statement in its batch and cannot run inside a transaction — hence one per breakpoint marker below.
-- (That marker string is deliberately not quoted anywhere in this file: applyMigrations splits the file on it
-- literally, so a comment containing it would be cut in half and the remainder parsed as SQL.)
-- IF NOT EXISTS makes the file re-runnable. A CONCURRENTLY build that fails leaves an INVALID index behind;
-- it is not used by the planner, and re-running this migration does not fix it (IF NOT EXISTS sees the
-- invalid index and skips) — drop it by name and re-run if that ever happens.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
-- Long index builds must not be killed by the migration timeout.
SET statement_timeout = 0;
--> statement-breakpoint

-- ── contacts: the six legs of the free-text OR (searchRepository.textCondition) ────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_trgm_first_name
  ON contacts USING gin (first_name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_trgm_last_name
  ON contacts USING gin (last_name gin_trgm_ops);
--> statement-breakpoint
-- The concat leg. An EXPRESSION index is only used when the indexed expression matches the query's
-- textually, so this must stay byte-identical to searchRepository's `coalesce(first_name, '') || ' ' ||
-- coalesce(last_name, '')`. Change one and the other stops being served.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_trgm_full_name
  ON contacts USING gin ((coalesce(first_name, '') || ' ' || coalesce(last_name, '')) gin_trgm_ops);
--> statement-breakpoint
-- job_title also carries the synonym-expanded title filters, so it is the hottest of these.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_trgm_job_title
  ON contacts USING gin (job_title gin_trgm_ops);
--> statement-breakpoint
-- email_domain and accounts.domain are CITEXT, not varchar, and that changes what is indexable:
-- `gin_trgm_ops` is defined over `text` and citext is not binary-coercible to it, so
-- `gin (email_domain gin_trgm_ops)` does not merely go unused — it FAILS to create ("no default operator
-- class"), which would break every migrate run. Both are therefore indexed as the `::text` expression, and
-- the queries are written to match: accountSearchRepository already casts, and searchRepository's
-- email_domain leg was changed to cast in this same commit. An expression index is only consulted when the
-- query's expression matches textually, so those two must be kept in step.
-- (Casting does not weaken matching: ILIKE is case-insensitive regardless of citext's own collation.)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_trgm_email_domain
  ON contacts USING gin ((email_domain::text) gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_trgm_linkedin_url
  ON contacts USING gin (linkedin_url gin_trgm_ops);
--> statement-breakpoint

-- ── accounts: the company-search text legs (accountSearchRepository) ──────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_accounts_trgm_name
  ON accounts USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_accounts_trgm_domain
  ON accounts USING gin ((domain::text) gin_trgm_ops);
--> statement-breakpoint

SET statement_timeout = '120s';
