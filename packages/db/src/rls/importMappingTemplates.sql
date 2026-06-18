-- importMappingTemplates.sql — Row-Level Security + updated_at trigger for saved import mapping templates
-- (G-IMP-3, 30 §8). Applied after the Drizzle migration creates the table (by packages/db/src/migrate.ts).
-- Fail-closed, workspace-scoped: the policy keys off the transaction-LOCAL GUC app.current_workspace_id set
-- by withTenantTx() under the NON-BYPASSRLS leadwolf_app role. NULLIF(current_setting(..., true), '') treats
-- an unset OR ''-reset GUC as no-scope, so an unscoped query reads nothing (fail-closed). Reuses the shared
-- set_updated_at() trigger function defined in contacts.sql (which sorts first, so it always exists by now).
-- Idempotent: safe to re-run on every migrate.

ALTER TABLE import_mapping_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_mapping_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS import_mapping_templates_workspace_isolation ON import_mapping_templates;
CREATE POLICY import_mapping_templates_workspace_isolation ON import_mapping_templates
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

DROP TRIGGER IF EXISTS import_mapping_templates_set_updated_at ON import_mapping_templates;
CREATE TRIGGER import_mapping_templates_set_updated_at BEFORE UPDATE ON import_mapping_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Grant the application role table privileges (RLS still constrains the rows it sees). The role is
-- created in the migrate bootstrap; GRANTs are idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON import_mapping_templates TO leadwolf_app;
