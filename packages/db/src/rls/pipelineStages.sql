-- pipelineStages.sql — Row-Level Security + updated_at trigger for the workspace pipeline-stage layer
-- (pipeline_stages — G-REV-7, ADR-0028). Workspace-scoped exactly like contacts; the policy keys off the
-- transaction-LOCAL GUC app.current_workspace_id set by withTenantTx() under the NON-BYPASSRLS leadwolf_app
-- role. NULLIF(current_setting(..., true), '') treats unset AND ''-reset GUCs as no-scope, so an unscoped
-- query reads/writes nothing (fail-closed). set_updated_at() is created in contacts.sql (sorted earlier).
-- Idempotent: safe to re-run on every migrate.

ALTER TABLE pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_stages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pipeline_stages_workspace_isolation ON pipeline_stages;
CREATE POLICY pipeline_stages_workspace_isolation ON pipeline_stages
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP TRIGGER IF EXISTS pipeline_stages_set_updated_at ON pipeline_stages;
CREATE TRIGGER pipeline_stages_set_updated_at BEFORE UPDATE ON pipeline_stages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON pipeline_stages TO leadwolf_app;
