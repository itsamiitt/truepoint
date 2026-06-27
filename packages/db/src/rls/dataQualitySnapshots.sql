-- dataQualitySnapshots.sql — RLS for the per-workspace Data Health trend store. Workspace-scoped like contacts;
-- the NULLIF idiom fails closed on an unset/reset GUC. The snapshot sweep inserts rows inside withTenantTx
-- (leadwolf_app, RLS-enforced). Idempotent — safe to re-run on every migrate.

ALTER TABLE data_quality_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_quality_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS data_quality_snapshots_workspace_isolation ON data_quality_snapshots;
CREATE POLICY data_quality_snapshots_workspace_isolation ON data_quality_snapshots
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON data_quality_snapshots TO leadwolf_app;
