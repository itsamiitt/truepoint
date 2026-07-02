-- revealJobs.sql — RLS for the async bulk-reveal tables (reveal-experience Phase 3). Workspace-scoped like
-- enrichment_jobs; both tables carry workspace_id directly (reveal_job_rows is denormalized) so neither can
-- leak across workspaces. NULLIF idiom → an unset/reset GUC fails closed. Idempotent — safe to re-run every
-- migrate.

ALTER TABLE reveal_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE reveal_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reveal_jobs_workspace_isolation ON reveal_jobs;
CREATE POLICY reveal_jobs_workspace_isolation ON reveal_jobs
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

ALTER TABLE reveal_job_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE reveal_job_rows FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reveal_job_rows_workspace_isolation ON reveal_job_rows;
CREATE POLICY reveal_job_rows_workspace_isolation ON reveal_job_rows
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON reveal_jobs, reveal_job_rows TO leadwolf_app;
