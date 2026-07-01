-- teams.sql — Row-Level Security + updated_at trigger for TEAMS (`teams`, `team_members` — Part D, decision #6).
-- Workspace-scoped EXACTLY like lists/contacts: the policy keys off the transaction-LOCAL GUC
-- app.current_workspace_id set by withTenantTx() under the NON-BYPASSRLS leadwolf_app role. NULLIF(..., '')
-- treats an unset/'' GUC as no-scope, so an unscoped query reads nothing (fail-closed). GROUPING ONLY: the
-- isolation boundary is the WORKSPACE, never the team — team membership does NOT restrict record visibility.
-- Reuses set_updated_at() from rls/contacts.sql (applyMigrations runs the rls files sorted; contacts is first).
-- Idempotent.

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS teams_workspace_isolation ON teams;
CREATE POLICY teams_workspace_isolation ON teams
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP TRIGGER IF EXISTS teams_set_updated_at ON teams;
CREATE TRIGGER teams_set_updated_at BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS team_members_workspace_isolation ON team_members;
CREATE POLICY team_members_workspace_isolation ON team_members
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON teams, team_members TO leadwolf_app;
