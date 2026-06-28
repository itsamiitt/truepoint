-- importJobs.sql — RLS for the bulk COPY-staging import tables (15-bulk-import-design, backlog #2). Workspace-
-- scoped like contacts; policies use the NULLIF idiom so unset/reset GUCs fail closed. import_jobs and
-- import_job_rows carry workspace_id directly; import_job_chunks is scoped THROUGH its parent job (it has no own
-- workspace_id) so it can never leak across workspaces. The per-job UNLOGGED staging table is non-RLS by design
-- (Postgres forbids COPY on RLS tables) and is isolated by access path in importStagingRepository — not here.
-- Idempotent — safe to re-run on every migrate.

ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS import_jobs_workspace_isolation ON import_jobs;
CREATE POLICY import_jobs_workspace_isolation ON import_jobs
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

ALTER TABLE import_job_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_job_rows FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS import_job_rows_workspace_isolation ON import_job_rows;
CREATE POLICY import_job_rows_workspace_isolation ON import_job_rows
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

-- Chunks have no own workspace_id — scope them through the parent job so they inherit the same isolation.
ALTER TABLE import_job_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_job_chunks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS import_job_chunks_workspace_isolation ON import_job_chunks;
CREATE POLICY import_job_chunks_workspace_isolation ON import_job_chunks
  USING (EXISTS (
    SELECT 1 FROM import_jobs j
     WHERE j.id = import_job_chunks.job_id
       AND j.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (EXISTS (
    SELECT 1 FROM import_jobs j
     WHERE j.id = import_job_chunks.job_id
       AND j.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid));

GRANT SELECT, INSERT, UPDATE, DELETE ON import_jobs, import_job_chunks, import_job_rows TO leadwolf_app;
