-- lists.sql — Row-Level Security + updated_at trigger for static prospect lists (`lists`, `list_members` —
-- 24, bulk add-to-list). Workspace-scoped exactly like contacts/saved_searches: the policy keys off the
-- transaction-LOCAL GUC app.current_workspace_id set by withTenantTx() under the NON-BYPASSRLS leadwolf_app
-- role. NULLIF(current_setting(..., true), '') treats an unset OR ''-reset GUC as no-scope, so an unscoped
-- query reads nothing (fail-closed) — the per-workspace isolation boundary. Owner-vs-workspace visibility (if
-- ever needed) is enforced in the repository/core layer; RLS guarantees the harder property: workspace A can
-- NEVER see workspace B's rows. Reuses the shared set_updated_at() from rls/contacts.sql (applyMigrations runs
-- the rls files sorted; contacts.sql is applied first). Idempotent.

-- ── lists ──────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE lists FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lists_workspace_isolation ON lists;
CREATE POLICY lists_workspace_isolation ON lists
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP TRIGGER IF EXISTS lists_set_updated_at ON lists;
CREATE TRIGGER lists_set_updated_at BEFORE UPDATE ON lists
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── list_members ───────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE list_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE list_members FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS list_members_workspace_isolation ON list_members;
CREATE POLICY list_members_workspace_isolation ON list_members
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON lists, list_members TO leadwolf_app;
