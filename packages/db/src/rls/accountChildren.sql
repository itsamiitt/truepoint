-- accountChildren.sql — Row-Level Security + updated_at triggers for the company-overlay child tables
-- `account_domains` + `account_locations` (import-and-data-model-redesign 06 §Security; S-A1/S-A3, migration
-- 0061). Identical IN FORM to rls/contacts.sql / rls/contactChannels.sql: policies key off the
-- transaction-LOCAL GUC app.current_workspace_id set by withTenantTx() under the NON-BYPASSRLS leadwolf_app
-- role; NULLIF(current_setting(..., true), '') treats unset AND ''-reset GUCs as no-scope, so an unscoped
-- query reads nothing (fail-closed). Scope is DIRECT on the denormalized workspace_id, never derived through
-- the accounts join — the child of a visible parent is not automatically visible; it carries its own wall
-- (the contact_emails / import_job_rows precedent, 06 §Security). No user GUC exists or is added (DM4).
-- Idempotent: safe to re-run on every migrate.

-- Shared updated_at trigger function (byte-identical CREATE OR REPLACE, same body as rls/contacts.sql).
-- Defined here too because applyMigrations applies rls/*.sql in SORTED order and "accountChildren.sql" sorts
-- BEFORE "contacts.sql" — on a fresh database the function must exist before the triggers below.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── account_domains ────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE account_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_domains FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_domains_workspace_isolation ON account_domains;
CREATE POLICY account_domains_workspace_isolation ON account_domains
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP TRIGGER IF EXISTS account_domains_set_updated_at ON account_domains;
CREATE TRIGGER account_domains_set_updated_at BEFORE UPDATE ON account_domains
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── account_locations ──────────────────────────────────────────────────────────────────────────────────
ALTER TABLE account_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_locations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_locations_workspace_isolation ON account_locations;
CREATE POLICY account_locations_workspace_isolation ON account_locations
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP TRIGGER IF EXISTS account_locations_set_updated_at ON account_locations;
CREATE TRIGGER account_locations_set_updated_at BEFORE UPDATE ON account_locations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Grant the application role table privileges (RLS still constrains the rows it sees). The role is created
-- in the migrate bootstrap; GRANTs are idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON account_domains, account_locations TO leadwolf_app;
