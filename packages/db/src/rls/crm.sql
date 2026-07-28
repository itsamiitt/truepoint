-- crm.sql — RLS for the CRM bidirectional-sync engine (crm-sync plan §4 / §7.1). All nine tables are
-- Layer-1 overlay, workspace-scoped under the app.current_workspace_id GUC; NULLIF(..., '') fails closed.
-- Applied AFTER the Drizzle migration creates the tables and AFTER rls/contacts.sql (alphabetical sort),
-- so the shared set_updated_at() function already exists. Idempotent — safe to re-run every migrate.
--
-- THE WRITE GUARANTEE is FORCE ROW LEVEL SECURITY + the per-command policy set, NOT the GRANTs at the
-- bottom: the [4/4] blanket GRANT in applyMigrations runs AFTER this file and re-widens leadwolf_app, so a
-- grant can never be the wall here. An append-only table is one that simply has no UPDATE/DELETE policy
-- under FORCE RLS (the retention_runs pattern).
--
-- FORCE (not ENABLE-only) is correct for all nine: every writer is the non-BYPASSRLS leadwolf_app role via
-- withTenantTx. The two privileged paths that must reach these rows — the DSAR fan-out (withPrivilegedTx)
-- and the staff DLQ-replay console (withPlatformTx) — run on BYPASSRLS roles that FORCE does not gate.

-- ── crm_connections — full workspace isolation (CRUD). owner_user_id is soft attribution (NOT a row
-- predicate); privileged mutations are app-gated + audited. The encrypted token is repo-layer safeColumns,
-- never RLS. ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE crm_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_connections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_connections_workspace_isolation ON crm_connections;
CREATE POLICY crm_connections_workspace_isolation ON crm_connections
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP TRIGGER IF EXISTS crm_connections_set_updated_at ON crm_connections;
CREATE TRIGGER crm_connections_set_updated_at BEFORE UPDATE ON crm_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── crm_record_links — full workspace isolation (CRUD; re-pointed on Lead->Contact, deleted by the
-- outbound erase job after the CRM erase confirms — §7.6). ───────────────────────────────────────────────
ALTER TABLE crm_record_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_record_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_record_links_workspace_isolation ON crm_record_links;
CREATE POLICY crm_record_links_workspace_isolation ON crm_record_links
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP TRIGGER IF EXISTS crm_record_links_set_updated_at ON crm_record_links;
CREATE TRIGGER crm_record_links_set_updated_at BEFORE UPDATE ON crm_record_links
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── crm_field_mappings — full workspace isolation (CRUD). ────────────────────────────────────────────────
ALTER TABLE crm_field_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_field_mappings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_field_mappings_workspace_isolation ON crm_field_mappings;
CREATE POLICY crm_field_mappings_workspace_isolation ON crm_field_mappings
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP TRIGGER IF EXISTS crm_field_mappings_set_updated_at ON crm_field_mappings;
CREATE TRIGGER crm_field_mappings_set_updated_at BEFORE UPDATE ON crm_field_mappings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── crm_sync_state — full workspace isolation (CRUD; UPDATE every sync to advance the watermark). ────────
ALTER TABLE crm_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_sync_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_sync_state_workspace_isolation ON crm_sync_state;
CREATE POLICY crm_sync_state_workspace_isolation ON crm_sync_state
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP TRIGGER IF EXISTS crm_sync_state_set_updated_at ON crm_sync_state;
CREATE TRIGGER crm_sync_state_set_updated_at BEFORE UPDATE ON crm_sync_state
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── crm_inbound_events — APPEND-ONLY: SELECT + INSERT policy only. No UPDATE/DELETE policy exists, so under
-- FORCE RLS those commands are denied for leadwolf_app (the retention_runs wall) — the inbound firehose is
-- immutable regardless of the blanket grant. ─────────────────────────────────────────────────────────────
ALTER TABLE crm_inbound_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_inbound_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_inbound_events_workspace_read ON crm_inbound_events;
CREATE POLICY crm_inbound_events_workspace_read ON crm_inbound_events FOR SELECT
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP POLICY IF EXISTS crm_inbound_events_workspace_insert ON crm_inbound_events;
CREATE POLICY crm_inbound_events_workspace_insert ON crm_inbound_events FOR INSERT
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

-- ── crm_sync_runs — APPEND + IN-PLACE PROGRESS: SELECT + INSERT + UPDATE (running -> completed; counts
-- mutate), NO DELETE policy (immutable ledger, like import_jobs). ────────────────────────────────────────
ALTER TABLE crm_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_sync_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_sync_runs_workspace_read ON crm_sync_runs;
CREATE POLICY crm_sync_runs_workspace_read ON crm_sync_runs FOR SELECT
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP POLICY IF EXISTS crm_sync_runs_workspace_insert ON crm_sync_runs;
CREATE POLICY crm_sync_runs_workspace_insert ON crm_sync_runs FOR INSERT
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP POLICY IF EXISTS crm_sync_runs_workspace_update ON crm_sync_runs;
CREATE POLICY crm_sync_runs_workspace_update ON crm_sync_runs FOR UPDATE
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

-- ── crm_sync_conflicts — full workspace isolation (CRUD; status open -> resolved/ignored). ───────────────
ALTER TABLE crm_sync_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_sync_conflicts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_sync_conflicts_workspace_isolation ON crm_sync_conflicts;
CREATE POLICY crm_sync_conflicts_workspace_isolation ON crm_sync_conflicts
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

-- ── crm_sync_dead_letter — APPEND-ONLY for the app role: SELECT + INSERT only (no UPDATE/DELETE policy ->
-- immutable for leadwolf_app under FORCE RLS). The status transitions (retry/resolve/ignore) on the staff
-- DLQ-replay console run on the owner/withPlatformTx (BYPASSRLS) connection, which the app-role policy wall
-- does not gate — the same separation audit_log/retention_runs use for privileged writes. ────────────────
ALTER TABLE crm_sync_dead_letter ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_sync_dead_letter FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_sync_dead_letter_workspace_read ON crm_sync_dead_letter;
CREATE POLICY crm_sync_dead_letter_workspace_read ON crm_sync_dead_letter FOR SELECT
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP POLICY IF EXISTS crm_sync_dead_letter_workspace_insert ON crm_sync_dead_letter;
CREATE POLICY crm_sync_dead_letter_workspace_insert ON crm_sync_dead_letter FOR INSERT
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

-- ── crm_oauth_states — full workspace isolation (CRUD; short-lived, consumed once). ──────────────────────
ALTER TABLE crm_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_oauth_states FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_oauth_states_workspace_isolation ON crm_oauth_states;
CREATE POLICY crm_oauth_states_workspace_isolation ON crm_oauth_states
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

-- ── Documentary / defense-in-depth grants. The real walls are the policies above; the [4/4] blanket grant
-- runs after this file and re-widens leadwolf_app, so these state intent rather than restrict on their own
-- (the retention.sql convention). Append-only tables list SELECT+INSERT; the run ledger lists
-- SELECT+INSERT+UPDATE; the rest list full DML. None is master_* so none is REVOKEd. ─────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON
  crm_connections, crm_record_links, crm_field_mappings, crm_sync_state, crm_sync_conflicts, crm_oauth_states
  TO leadwolf_app;
GRANT SELECT, INSERT, UPDATE ON crm_sync_runs TO leadwolf_app;
GRANT SELECT, INSERT ON crm_inbound_events, crm_sync_dead_letter TO leadwolf_app;
