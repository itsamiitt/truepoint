-- contactChannels.sql — Row-Level Security + updated_at triggers for the multi-value channel child tables
-- `contact_emails` + `contact_phones` (import-and-data-model-redesign 05 §2.4; S-CH1, migration 0058).
-- Identical IN FORM to rls/contacts.sql: policies key off the transaction-LOCAL GUC app.current_workspace_id
-- set by withTenantTx() under the NON-BYPASSRLS leadwolf_app role; NULLIF(current_setting(..., true), '')
-- treats unset AND ''-reset GUCs as no-scope, so an unscoped query reads nothing (fail-closed). Scope is
-- DIRECT on the denormalized workspace_id, never derived through the contacts join — the child of a visible
-- parent is not automatically visible; it carries its own wall (the import_job_rows precedent, 05 §2.4).
-- No user GUC exists or is added (DM4). Idempotent: safe to re-run on every migrate.

-- Shared updated_at trigger function. Defined here too (byte-identical CREATE OR REPLACE, same body as
-- rls/contacts.sql) because applyMigrations applies rls/*.sql in SORTED order and "contactChannels.sql"
-- sorts BEFORE "contacts.sql" — on a fresh database the function must exist before the triggers below.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── contact_emails ─────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE contact_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_emails FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_emails_workspace_isolation ON contact_emails;
CREATE POLICY contact_emails_workspace_isolation ON contact_emails
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP TRIGGER IF EXISTS contact_emails_set_updated_at ON contact_emails;
CREATE TRIGGER contact_emails_set_updated_at BEFORE UPDATE ON contact_emails
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── contact_phones ─────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE contact_phones ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_phones FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_phones_workspace_isolation ON contact_phones;
CREATE POLICY contact_phones_workspace_isolation ON contact_phones
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP TRIGGER IF EXISTS contact_phones_set_updated_at ON contact_phones;
CREATE TRIGGER contact_phones_set_updated_at BEFORE UPDATE ON contact_phones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Grant the application role table privileges (RLS still constrains the rows it sees). The role is
-- created in the migrate bootstrap; GRANTs are idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON contact_emails, contact_phones TO leadwolf_app;
