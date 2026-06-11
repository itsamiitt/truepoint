-- outreach.sql — RLS + the updated_at trigger for the M9 outreach engine (03 §7/§9, 05 §13, ADR-0009).
-- Workspace-scoped like contacts; policies use the NULLIF idiom so unset/reset GUCs fail closed. Reuses
-- the shared set_updated_at() defined in rls/contacts.sql (applyMigrations runs the rls files sorted, so
-- contacts.sql has already created it). Idempotent — safe to re-run on every migrate.

ALTER TABLE outreach_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_sequences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outreach_sequences_workspace_isolation ON outreach_sequences;
CREATE POLICY outreach_sequences_workspace_isolation ON outreach_sequences
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP TRIGGER IF EXISTS outreach_sequences_set_updated_at ON outreach_sequences;
CREATE TRIGGER outreach_sequences_set_updated_at BEFORE UPDATE ON outreach_sequences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE outreach_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_steps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outreach_steps_workspace_isolation ON outreach_steps;
CREATE POLICY outreach_steps_workspace_isolation ON outreach_steps
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

ALTER TABLE outreach_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outreach_log_workspace_isolation ON outreach_log;
CREATE POLICY outreach_log_workspace_isolation ON outreach_log
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON outreach_sequences, outreach_steps, outreach_log TO leadwolf_app;
