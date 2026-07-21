-- scheduledImports.sql — Row-Level Security + updated_at trigger for per-workspace scheduled imports
-- (import-and-data-model-redesign 08 §9, P5). Applied after the Drizzle migration creates the table (by
-- packages/db/src/applyMigrations.ts step [3/4]). Fail-closed, workspace-scoped exactly like import_policy /
-- import_mapping_templates (the idiom this table mirrors): the policy keys off the transaction-LOCAL GUC
-- app.current_workspace_id set by withTenantTx() under the NON-BYPASSRLS leadwolf_app role.
-- NULLIF(current_setting(..., true), '') treats an unset OR ''-reset GUC as no-scope, so an unscoped query
-- reads nothing (fail-closed). Reuses the shared set_updated_at() function (defined in contacts.sql, which
-- sorts first so it always exists by now). Idempotent: safe to re-run on every migrate.
--
-- The leader-locked sweep reads scheduled_imports SYSTEM-LEVEL on the owner connection (no GUC) for its due
-- census — a read that does NOT go through this policy (owner connection, explicit workspace predicates ARE
-- the scope, mirroring importJobRepository.listNonTerminalImportJobs). Every fire then re-scopes into the
-- schedule's own workspace via withTenantTx, where THIS policy walls the submit + the audit/notify writes.

ALTER TABLE scheduled_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_imports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduled_imports_workspace_isolation ON scheduled_imports;
CREATE POLICY scheduled_imports_workspace_isolation ON scheduled_imports
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

DROP TRIGGER IF EXISTS scheduled_imports_set_updated_at ON scheduled_imports;
CREATE TRIGGER scheduled_imports_set_updated_at BEFORE UPDATE ON scheduled_imports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Grant the application role table privileges (RLS still constrains the rows it sees). Idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON scheduled_imports TO leadwolf_app;
