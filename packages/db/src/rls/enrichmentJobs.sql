-- enrichmentJobs.sql — RLS for the bulk CSV enrichment tables (Wave 1). Workspace-scoped like contacts;
-- policies use the NULLIF idiom so unset/reset GUCs fail closed. enrichment_jobs and enrichment_job_rows
-- carry workspace_id directly; enrichment_job_chunks is scoped THROUGH its parent job (it has no own
-- workspace_id) so it can never leak across workspaces. Idempotent — safe to re-run on every migrate.

ALTER TABLE enrichment_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrichment_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS enrichment_jobs_workspace_isolation ON enrichment_jobs;
CREATE POLICY enrichment_jobs_workspace_isolation ON enrichment_jobs
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

ALTER TABLE enrichment_job_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrichment_job_rows FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS enrichment_job_rows_workspace_isolation ON enrichment_job_rows;
CREATE POLICY enrichment_job_rows_workspace_isolation ON enrichment_job_rows
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

-- Chunks have no own workspace_id — scope them through the parent job so they inherit the same isolation.
ALTER TABLE enrichment_job_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrichment_job_chunks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS enrichment_job_chunks_workspace_isolation ON enrichment_job_chunks;
CREATE POLICY enrichment_job_chunks_workspace_isolation ON enrichment_job_chunks
  USING (EXISTS (
    SELECT 1 FROM enrichment_jobs j
     WHERE j.id = enrichment_job_chunks.job_id
       AND j.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (EXISTS (
    SELECT 1 FROM enrichment_jobs j
     WHERE j.id = enrichment_job_chunks.job_id
       AND j.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid));

GRANT SELECT, INSERT, UPDATE, DELETE ON enrichment_jobs, enrichment_job_chunks, enrichment_job_rows TO leadwolf_app;
