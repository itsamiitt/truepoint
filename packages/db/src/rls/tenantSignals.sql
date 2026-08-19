-- tenantSignals.sql — RLS for the Layer-1 signal projection (market-intelligence MI-S6). Workspace-scoped
-- like intel.sql's tables; the NULLIF idiom fails closed on an unset/reset GUC. Idempotent — safe to
-- re-run on every migrate.

ALTER TABLE tenant_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_signals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_signals_workspace_isolation ON tenant_signals;
CREATE POLICY tenant_signals_workspace_isolation ON tenant_signals
  USING (workspace_id = (SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (workspace_id = (SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid));

GRANT SELECT, INSERT, DELETE ON tenant_signals TO leadwolf_app;
