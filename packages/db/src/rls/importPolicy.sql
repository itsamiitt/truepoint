-- importPolicy.sql — Row-Level Security + updated_at trigger for the per-workspace import policy
-- (import-and-data-model-redesign 10 §3, S-V1): the G02 who_can_import knob + the 08 §5 strategy defaults.
-- Workspace-scoped exactly like enrichment_policy (the idiom this table mirrors): the policy keys off the
-- transaction-LOCAL GUC app.current_workspace_id set by withTenantTx() under the NON-BYPASSRLS leadwolf_app
-- role. NULLIF(current_setting(..., true), '') treats unset AND ''-reset GUCs as no-scope, so an unscoped
-- query reads nothing (fail-closed). Reuses the shared set_updated_at() function (defined in contacts.sql,
-- applied earlier in the alphabetical rls/*.sql order). Idempotent: safe to re-run on every migrate.

ALTER TABLE import_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_policy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS import_policy_workspace_isolation ON import_policy;
CREATE POLICY import_policy_workspace_isolation ON import_policy
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

DROP TRIGGER IF EXISTS import_policy_set_updated_at ON import_policy;
CREATE TRIGGER import_policy_set_updated_at BEFORE UPDATE ON import_policy
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Grant the application role table privileges (RLS still constrains the rows it sees). Idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON import_policy TO leadwolf_app;
