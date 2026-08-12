-- 0109_fk_access_path_indexes.sql — index the foreign keys and access paths that had none (audit 32 §9.3).
--
-- EXPAND ONLY: no table, column or constraint is altered except the one FK repair at the foot. Every index
-- below was verified missing against all CREATE INDEX statements in migrations 0000–0108 before being added,
-- because a redundant index is not free — it is write amplification on every INSERT and UPDATE forever.
--
-- ── WHY THESE SPECIFIC ONES ─────────────────────────────────────────────────────────────────────────────
-- Two distinct problems, both invisible until the table is large:
--
--   1. CASCADE DELETES WITH NO SUPPORTING INDEX. Postgres does not auto-index the referencing side of a
--      foreign key. Deleting one parent row therefore SEQUENTIALLY SCANS every child table that references
--      it. For a DSAR erasure — which cascades from master_persons through emails and phones — that is a
--      full scan of tables sized for the whole graph, per subject, inside the deletion transaction.
--
--   2. LEADING-COLUMN MISMATCH. Several tables DO have an index, but it leads with the wrong column for the
--      way the application actually reads them. A unique on (tag_id, entity, record_id) cannot serve "what
--      tags does this contact have", which is the primary read direction. A unique on (workspace_id, user_id)
--      cannot serve "which workspaces is this user in", which is the LOGIN path.
--
-- Three tables here had NO secondary index at all — scores, intent_signals and consent_records — so a
-- contact delete scanned them end to end and the RLS workspace predicate on consent_records was itself
-- unindexed.
--
-- ── CONCURRENTLY IS SAFE IN THIS MIGRATOR, AND THAT IS NOT OBVIOUS ──────────────────────────────────────
-- applyMigrations.ts runs each statement separately in AUTOCOMMIT, so there is no enclosing transaction and
-- CONCURRENTLY is legal. This is the same arrangement 0106 documents and depends on; read its header before
-- copying the pattern anywhere else. The invalid-leftover sweep below exists for the same reason it does
-- there: a failed CONCURRENTLY build leaves an INVALID index that the migrator's already-exists tolerance
-- would happily skip past forever — never used by the planner, still maintained on every write.
--
-- These are hand-authored rather than declared in the Drizzle schema for the reason 0106 states: Drizzle
-- emits a plain, blocking CREATE INDEX for anything in a schema file.

-- Clear invalid leftovers from any previously-interrupted build of these indexes. Scoped by name, so it can
-- never touch an unrelated index; matches nothing on a fresh database.
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
       AND c.relname IN ('idx_scores_contact',
                         'idx_intent_signals_contact',
                         'idx_consent_records_ws_contact',
                         'idx_master_emails_person',
                         'idx_master_phones_person',
                         'idx_match_links_source_record',
                         'idx_source_imports_contact',
                         'idx_tenant_members_user',
                         'idx_workspace_members_user',
                         'idx_record_tags_record',
                         'idx_outreach_log_contact',
                         'idx_credit_ledger_reveal',
                         'idx_credit_ledger_purchase',
                         'idx_email_thread_contact',
                         'idx_saved_searches_workspace',
                         'idx_master_technology_aliases_tech',
                         'idx_scheduled_imports_target_list')
  LOOP
    EXECUTE format('DROP INDEX CONCURRENTLY IF EXISTS public.%I', r.relname);
  END LOOP;
END $$;
--> statement-breakpoint

-- ── The three tables that had NO secondary index at all ─────────────────────────────────────────────────
-- Each is a CASCADE child of contacts: without these, deleting one contact scans all three.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_scores_contact
  ON scores (contact_id);
--> statement-breakpoint

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_intent_signals_contact
  ON intent_signals (contact_id);
--> statement-breakpoint

-- Workspace first: it serves BOTH the cascade delete and the RLS predicate, which was itself unindexed.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_consent_records_ws_contact
  ON consent_records (workspace_id, contact_id);
--> statement-breakpoint

-- ── Layer-0 cascade children (the DSAR erasure path) ────────────────────────────────────────────────────
-- The existing uniques are on the blind index, which cannot serve a delete by person.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_emails_person
  ON master_emails (master_person_id);
--> statement-breakpoint

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_phones_person
  ON master_phones (master_person_id);
--> statement-breakpoint

-- match_links is indexed on (entity_type, cluster_id) — nothing serves a delete of the source record.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_match_links_source_record
  ON match_links (source_record_id);
--> statement-breakpoint

-- ── Leading-column mismatches ───────────────────────────────────────────────────────────────────────────
-- source_imports has three workspace-leading indexes; none is contact-leading, and it is a high-volume
-- CASCADE child of contacts.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_source_imports_contact
  ON source_imports (contact_id);
--> statement-breakpoint

-- "Which orgs / workspaces is this user in" — the LOGIN path. The existing uniques lead with tenant_id and
-- workspace_id respectively, so neither can answer it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tenant_members_user
  ON tenant_members (user_id);
--> statement-breakpoint

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workspace_members_user
  ON workspace_members (user_id);
--> statement-breakpoint

-- "Show the tags on this record" — the primary read direction. The unique leads with tag_id, which answers
-- the opposite question.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_record_tags_record
  ON record_tags (entity, record_id);
--> statement-breakpoint

-- The unique is (sequence_id, contact_id); a contact delete has nothing to use.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outreach_log_contact
  ON outreach_log (contact_id);
--> statement-breakpoint

-- ── SET NULL parents (a refund or a purgeated reveal scans the ledger without these) ─────────────────────
-- Partial: most ledger rows are neither a reveal settlement nor a purchase grant.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_credit_ledger_reveal
  ON credit_ledger (reveal_id)
  WHERE reveal_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_credit_ledger_purchase
  ON credit_ledger (purchase_id)
  WHERE purchase_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_email_thread_contact
  ON email_thread (contact_id)
  WHERE contact_id IS NOT NULL;
--> statement-breakpoint

-- Workspace-scoped and list-read on every Prospect page load, with no index at all until now.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_saved_searches_workspace
  ON saved_searches (workspace_id);
--> statement-breakpoint

-- The unique is (alias, technology_id); a technology delete cascades without support.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_technology_aliases_tech
  ON master_technology_aliases (technology_id);
--> statement-breakpoint

-- ── The dangling pointer (audit 32 §9.3, second P0) ─────────────────────────────────────────────────────
-- scheduled_imports.target_list_id is documented in the schema as "SET NULL: a deleted list detaches, never
-- blocks" — but it was declared as a bare uuid with NO foreign key, so no SET NULL could ever fire. A
-- deleted list left a dangling id that the sweep hands straight to submitCopyImport on the next fire.
--
-- Orphans are nulled FIRST: adding the constraint over existing dangling values would fail the migration,
-- and those values are already meaningless — the list they name is gone.
UPDATE scheduled_imports s
   SET target_list_id = NULL
 WHERE s.target_list_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM lists l WHERE l.id = s.target_list_id);
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_imports_target_list_id_fkey'
  ) THEN
    ALTER TABLE scheduled_imports
      ADD CONSTRAINT scheduled_imports_target_list_id_fkey
      FOREIGN KEY (target_list_id) REFERENCES lists(id) ON DELETE SET NULL;
  END IF;
END $$;
--> statement-breakpoint

-- Supports the SET NULL above: without it, deleting a list scans scheduled_imports.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_scheduled_imports_target_list
  ON scheduled_imports (target_list_id)
  WHERE target_list_id IS NOT NULL;

-- DOWN (manual; this project is forward-only, recorded for the incident case):
--   ALTER TABLE scheduled_imports DROP CONSTRAINT IF EXISTS scheduled_imports_target_list_id_fkey;
--   DROP INDEX CONCURRENTLY IF EXISTS idx_scheduled_imports_target_list;
--   ...and DROP INDEX CONCURRENTLY IF EXISTS for each index created above.
-- Dropping these is safe for correctness and costly for performance: every path above reverts to a scan.
