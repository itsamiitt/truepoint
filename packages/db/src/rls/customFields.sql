-- customFields.sql — Row-Level Security + updated_at trigger for the record-customization registry
-- (custom_field_definitions — ADR-0028, 03 §14, gap G-REV-5). The values themselves live in the
-- `custom_fields` jsonb column on contacts/accounts, already isolated by rls/contacts.sql. Applied after the
-- Drizzle migration creates the table (by packages/db/src/applyMigrations.ts). Policy keys off the
-- transaction-LOCAL GUC app.current_workspace_id set by withTenantTx() under the NON-BYPASSRLS leadwolf_app
-- role; NULLIF(current_setting(..., true), '') treats unset AND ''-reset GUCs as no-scope, so an unscoped
-- query reads nothing (fail-closed). Reuses set_updated_at() from rls/contacts.sql (globbed earlier).
-- Idempotent: safe to re-run on every migrate.

-- ── custom_field_definitions ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE custom_field_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_field_definitions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS custom_field_definitions_workspace_isolation ON custom_field_definitions;
CREATE POLICY custom_field_definitions_workspace_isolation ON custom_field_definitions
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP TRIGGER IF EXISTS custom_field_definitions_set_updated_at ON custom_field_definitions;
CREATE TRIGGER custom_field_definitions_set_updated_at BEFORE UPDATE ON custom_field_definitions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Grant the application role table privileges (RLS still constrains the rows it sees). The role is
-- created in the migrate bootstrap; GRANTs are idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON custom_field_definitions TO leadwolf_app;
