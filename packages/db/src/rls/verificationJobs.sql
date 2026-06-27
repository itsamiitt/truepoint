-- verificationJobs.sql — RLS for the freshness re-verification audit ledger. Workspace-scoped like contacts;
-- the NULLIF idiom fails closed on an unset/reset GUC. The reverify worker inserts rows inside withTenantTx
-- (leadwolf_app, RLS-enforced). Idempotent — safe to re-run on every migrate.

ALTER TABLE verification_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS verification_jobs_workspace_isolation ON verification_jobs;
CREATE POLICY verification_jobs_workspace_isolation ON verification_jobs
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON verification_jobs TO leadwolf_app;
