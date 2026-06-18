-- enrichmentPolicy.sql — Row-Level Security + updated_at trigger for the per-workspace auto-enrich policy
-- (G-ENR-1; 29 §3, 06 §4.1). Workspace-scoped exactly like contacts: the policy keys off the transaction-
-- LOCAL GUC app.current_workspace_id set by withTenantTx() under the NON-BYPASSRLS leadwolf_app role.
-- NULLIF(current_setting(..., true), '') treats unset AND ''-reset GUCs as no-scope, so an unscoped query
-- reads nothing (fail-closed). Reuses the shared set_updated_at() function (defined in contacts.sql, applied
-- earlier in the alphabetical rls/*.sql order). Idempotent: safe to re-run on every migrate.

ALTER TABLE enrichment_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrichment_policy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS enrichment_policy_workspace_isolation ON enrichment_policy;
CREATE POLICY enrichment_policy_workspace_isolation ON enrichment_policy
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

DROP TRIGGER IF EXISTS enrichment_policy_set_updated_at ON enrichment_policy;
CREATE TRIGGER enrichment_policy_set_updated_at BEFORE UPDATE ON enrichment_policy
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Grant the application role table privileges (RLS still constrains the rows it sees). Idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON enrichment_policy TO leadwolf_app;
