-- aiRequests.sql — Row-Level Security for `ai_requests` (M14 AI metering). Workspace-scoped exactly like
-- notifications/contacts: the policy keys off the transaction-LOCAL GUC app.current_workspace_id set by
-- withTenantTx() under the NON-BYPASSRLS leadwolf_app role. NULLIF(current_setting(..., true), '') treats an
-- unset OR ''-reset GUC as no-scope, so an unscoped query reads nothing (fail-closed). Platform staff read the
-- log CROSS-TENANT on the base owner connection (BYPASSRLS), which this policy does not constrain. Metering
-- rows are immutable in practice, but UPDATE/DELETE are granted for parity + future retention pruning.

ALTER TABLE ai_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_requests_workspace_isolation ON ai_requests;
CREATE POLICY ai_requests_workspace_isolation ON ai_requests
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_requests TO leadwolf_app;
