-- 0140_search_recency_filter_indexes.sql — index the three search filters added with the Search-tab
-- filter-completeness work. [S-10][S-04][S-13]
--
-- EXPAND ONLY, hand-authored per the 0109/0132 posture (drizzle-kit emits only plain blocking CREATE INDEX;
-- these are partial and must be CONCURRENTLY on a hot table). Each was verified missing against the existing
-- CREATE INDEX statements and the Drizzle schema defs before being added — a redundant index is write
-- amplification forever.
--
-- What is newly filterable and why each needs an index:
--
--   1. last_verified_at (range) — "how stale is this record", the verification-recency question [S-10].
--      PARTIAL on NOT NULL: a never-verified contact (NULL) can never satisfy a bounded range, so indexing
--      those rows would grow the index by the majority of a young workspace for entries that can never be
--      returned. searchRepository compares the BARE column (0132's P2.2 posture) so this is usable.
--
--   2. phone_line_type (term IN) — the TCPA-relevant mobile-vs-landline signal, filterable pre-reveal
--      [S-04]. Nullable and sparsely populated (only contacts whose phone has been graded by a carrier
--      lookup carry one), so the same NOT NULL partial applies.
--
--   3. intent_signals(contact_id, detected_at) WHERE signal_type = 'job_change' — the correlated subquery
--      behind the "changed job recently" range [S-13]. Without it the subquery re-scans that contact's
--      signal rows per candidate row of the outer search. Partial on the one signal_type the filter reads:
--      the filter is deliberately NOT a general signal-recency filter (that would be X-04 intent data, a
--      deferred non-goal), so the index is scoped exactly as narrowly as the query it serves.
--
-- CONCURRENTLY is safe in this migrator: applyMigrations.ts runs each statement separately in AUTOCOMMIT
-- (0106/0109 document this). The invalid-leftover sweep exists for the same reason as 0109's and 0132's: a
-- failed CONCURRENTLY build leaves an INVALID index that the already-exists tolerance would skip forever.

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
       AND c.relname IN ('idx_contacts_ws_last_verified_at',
                         'idx_contacts_ws_phone_line_type',
                         'idx_intent_signals_job_change')
  LOOP
    EXECUTE format('DROP INDEX CONCURRENTLY IF EXISTS public.%I', r.relname);
  END LOOP;
END $$;
--> statement-breakpoint

-- Long index builds must not be killed by the migration timeout.
SET statement_timeout = 0;
--> statement-breakpoint

-- ── contacts: verification recency [S-10] ────────────────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_ws_last_verified_at
  ON contacts (workspace_id, last_verified_at DESC)
  WHERE deleted_at IS NULL AND last_verified_at IS NOT NULL;
--> statement-breakpoint

-- ── contacts: carrier line type [S-04] ───────────────────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_ws_phone_line_type
  ON contacts (workspace_id, phone_line_type)
  WHERE deleted_at IS NULL AND phone_line_type IS NOT NULL;
--> statement-breakpoint

-- ── intent_signals: the job-change recency subquery [S-13] ───────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_intent_signals_job_change
  ON intent_signals (contact_id, detected_at DESC)
  WHERE signal_type = 'job_change';
