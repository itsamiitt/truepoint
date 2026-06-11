-- compliance.sql — RLS for the M5 compliance layer (03 §8/§9, 08 §2/§4). consent_records is
-- workspace-scoped like contacts. dsar_requests is PLATFORM-owned: the app role gets NO policy and NO
-- grant — only the privileged leadwolf_admin role (the audited DSAR path, 08 §9) may touch it.
-- Idempotent — safe to re-run on every migrate.

ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS consent_workspace_isolation ON consent_records;
CREATE POLICY consent_workspace_isolation ON consent_records
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON consent_records TO leadwolf_app;

-- dsar_requests: RLS enabled with NO policy → deny-all for any policy-subject role. The blanket GRANTs in
-- applyMigrations give leadwolf_app table privileges, but FORCE RLS + no policy yields zero rows / no
-- writes for it; leadwolf_admin BYPASSRLS reads/writes freely (the one privileged compliance path).
ALTER TABLE dsar_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE dsar_requests FORCE ROW LEVEL SECURITY;
