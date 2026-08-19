-- 0132_search_filter_indexes.sql — index the search-filter and session access paths that had none
-- (perf-audit P2.1; the Phase-2 batch of the 2026-08-19 performance audit). [S-04][S-09]
--
-- EXPAND ONLY, hand-authored per the 0109 posture (drizzle-kit emits only plain blocking CREATE INDEX; these
-- are partial/expression/GIN and must be CONCURRENTLY on hot tables). Every index below was verified missing
-- against all CREATE INDEX statements in migrations 0000–0131 AND the Drizzle schema defs before being added
-- — a redundant index is write amplification forever.
--
-- What was unindexed and why it matters:
--   1. user_sessions had ONE index (the partial refresh-hash unique) — every "sessions for this user" read
--      (self-service security page, logout-all) and the admin active-sessions join seq-scanned a table that
--      grows on every login and rotation and is never pruned.
--   2. contacts' enum-ish filter columns (email_status / outreach_status / seniority_level) and the ILIKE
--      facets (department / location_city / location_country) had no index at all — every faceted search
--      combination fell back to a heap scan of the RLS-visible workspace slice (searchRepository.ts
--      clauseCondition). The trgm GINs mirror 0081's posture for the contains-match legs.
--   3. accounts' funding_stage / company_stage filters (searchRepository.ts:170-173) — same gap.
--   4. suppression_list's RLS read policy probes (scope, tenant_id, workspace_id) on EVERY search via the
--      NOT_SUPPRESSED anti-join, with only per-rung partial indexes present. The anti-join itself measured
--      fine (searchRepository.ts:273-284 records the numbers) — this is the cheap insurance the audit
--      recommended for when the GLOBAL DNC list outgrows that measurement's envelope.
--
-- CONCURRENTLY is safe in this migrator: applyMigrations.ts runs each statement separately in AUTOCOMMIT
-- (0106/0109 document this). The invalid-leftover sweep exists for the same reason as 0109's: a failed
-- CONCURRENTLY build leaves an INVALID index the already-exists tolerance would skip past forever.

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
       AND c.relname IN ('idx_user_sessions_user_created',
                         'idx_user_sessions_ws_active',
                         'idx_contacts_ws_email_status',
                         'idx_contacts_ws_outreach_status',
                         'idx_contacts_ws_seniority',
                         'idx_contacts_trgm_department',
                         'idx_contacts_trgm_location_city',
                         'idx_contacts_trgm_location_country',
                         'idx_accounts_ws_funding_stage',
                         'idx_accounts_ws_company_stage',
                         'idx_suppression_scope_tenant')
  LOOP
    EXECUTE format('DROP INDEX CONCURRENTLY IF EXISTS public.%I', r.relname);
  END LOOP;
END $$;
--> statement-breakpoint

-- Long index builds must not be killed by the migration timeout.
SET statement_timeout = 0;
--> statement-breakpoint

-- ── user_sessions (auth origin; grows per login + rotation, never pruned — the prune sweep is P2.8) ──────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_sessions_user_created
  ON user_sessions (user_id, created_at DESC);
--> statement-breakpoint
-- The admin active-sessions list: live rows only, newest first.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_sessions_ws_active
  ON user_sessions (workspace_id, created_at DESC)
  WHERE revoked_at IS NULL;
--> statement-breakpoint

-- ── contacts: the enum-ish term filters (inArray probes under the RLS workspace predicate) ───────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_ws_email_status
  ON contacts (workspace_id, email_status)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_ws_outreach_status
  ON contacts (workspace_id, outreach_status)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
-- seniority_level is nullable and a NULL can never match the inArray probe — exclude them so the index
-- stays small on datasets where seniority is sparsely populated.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_ws_seniority
  ON contacts (workspace_id, seniority_level)
  WHERE deleted_at IS NULL AND seniority_level IS NOT NULL;
--> statement-breakpoint

-- ── contacts: the ILIKE '%…%' facets (department / location) — trgm GINs, the 0081 posture ──────────────
-- (pg_trgm is already installed by 0081; leading-wildcard ILIKE is exactly what these accelerate.)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_trgm_department
  ON contacts USING gin (department gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_trgm_location_city
  ON contacts USING gin (location_city gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_trgm_location_country
  ON contacts USING gin (location_country gin_trgm_ops);
--> statement-breakpoint

-- ── accounts: the firmographic stage filters ──────────────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_accounts_ws_funding_stage
  ON accounts (workspace_id, funding_stage)
  WHERE funding_stage IS NOT NULL;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_accounts_ws_company_stage
  ON accounts (workspace_id, company_stage)
  WHERE company_stage IS NOT NULL;
--> statement-breakpoint

-- ── suppression_list: the RLS scope probe (global + this-tenant + this-workspace rows on every search) ───
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_suppression_scope_tenant
  ON suppression_list (scope, tenant_id, workspace_id);

-- DOWN (manual; forward-only project): DROP INDEX CONCURRENTLY IF EXISTS for each index above. Safe for
-- correctness, costly for performance: every filter above reverts to a workspace heap scan.
