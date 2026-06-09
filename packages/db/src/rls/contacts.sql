-- contacts.sql — Row-Level Security + updated_at triggers for the per-workspace data layer
-- (accounts, contacts, source_imports — 03 §5/§9/§10, ADR-0006). Applied after the Drizzle migration
-- creates the tables (by packages/db/src/migrate.ts). Policies key off the transaction-LOCAL GUC
-- app.current_workspace_id set by withTenantTx() under the NON-BYPASSRLS leadwolf_app role;
-- current_setting(..., true) returns NULL when unset, so an unscoped query reads nothing (fail-closed).
-- Idempotent: safe to re-run on every migrate.

-- Shared updated_at trigger function (referenced by accounts/contacts; also covers future tables).
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── accounts ───────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS accounts_workspace_isolation ON accounts;
CREATE POLICY accounts_workspace_isolation ON accounts
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id', true)::uuid);
DROP TRIGGER IF EXISTS accounts_set_updated_at ON accounts;
CREATE TRIGGER accounts_set_updated_at BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── contacts ───────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contacts_workspace_isolation ON contacts;
CREATE POLICY contacts_workspace_isolation ON contacts
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id', true)::uuid);
DROP TRIGGER IF EXISTS contacts_set_updated_at ON contacts;
CREATE TRIGGER contacts_set_updated_at BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── source_imports ─────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE source_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_imports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS source_imports_workspace_isolation ON source_imports;
CREATE POLICY source_imports_workspace_isolation ON source_imports
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id', true)::uuid);

-- Grant the application role table privileges (RLS still constrains the rows it sees). The role is
-- created in the migrate bootstrap; GRANTs are idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON accounts, contacts, source_imports TO leadwolf_app;
