-- savedSearches.sql — Row-Level Security + updated_at trigger for `saved_searches` (M8, 24 §8). Workspace-
-- scoped exactly like contacts/outreach: the policy keys off the transaction-LOCAL GUC app.current_workspace_id
-- set by withTenantTx() under the NON-BYPASSRLS leadwolf_app role. NULLIF(current_setting(..., true), '')
-- treats an unset OR ''-reset GUC as no-scope, so an unscoped query reads nothing (fail-closed) — this is the
-- per-workspace isolation boundary proven by the itest. Owner-vs-workspace VISIBILITY (private rows readable
-- only by their owner) is enforced in the repository/core layer (the GUC carries no user id); RLS guarantees
-- the harder property: workspace A can NEVER see workspace B's rows. Reuses the shared set_updated_at() from
-- rls/contacts.sql (applyMigrations runs the rls files sorted; contacts.sql is applied first). Idempotent.

ALTER TABLE saved_searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_searches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saved_searches_workspace_isolation ON saved_searches;
CREATE POLICY saved_searches_workspace_isolation ON saved_searches
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP TRIGGER IF EXISTS saved_searches_set_updated_at ON saved_searches;
CREATE TRIGGER saved_searches_set_updated_at BEFORE UPDATE ON saved_searches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON saved_searches TO leadwolf_app;
