-- email.sql — RLS + updated_at triggers for the M12 email subsystem (email-planning/13 P0, 14 §2.1).
-- sending_domain is TENANT-scoped (a tenant asset shared across its workspaces); mailbox_integration and
-- email_event are WORKSPACE-scoped like contacts/outreach. The NULLIF idiom makes an unset/reset GUC fail
-- closed (matches zero rows). Reuses the shared set_updated_at() defined in rls/contacts.sql (applyMigrations
-- runs the rls files sorted, and 'contacts' < 'email', so the function already exists). Idempotent — safe to
-- re-run on every migrate. (email_event is append-only: no updated_at column, no trigger.)

-- sending_domain — TENANT-scoped
ALTER TABLE sending_domain ENABLE ROW LEVEL SECURITY;
ALTER TABLE sending_domain FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sending_domain_tenant_isolation ON sending_domain;
CREATE POLICY sending_domain_tenant_isolation ON sending_domain
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
DROP TRIGGER IF EXISTS sending_domain_set_updated_at ON sending_domain;
CREATE TRIGGER sending_domain_set_updated_at BEFORE UPDATE ON sending_domain
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- mailbox_integration — WORKSPACE-scoped
ALTER TABLE mailbox_integration ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailbox_integration FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mailbox_integration_workspace_isolation ON mailbox_integration;
CREATE POLICY mailbox_integration_workspace_isolation ON mailbox_integration
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP TRIGGER IF EXISTS mailbox_integration_set_updated_at ON mailbox_integration;
CREATE TRIGGER mailbox_integration_set_updated_at BEFORE UPDATE ON mailbox_integration
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- email_event — WORKSPACE-scoped, append-only (no updated_at trigger)
ALTER TABLE email_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_event_workspace_isolation ON email_event;
CREATE POLICY email_event_workspace_isolation ON email_event
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

-- email_template — WORKSPACE-scoped (owner-scope is an app filter on top, D8)
ALTER TABLE email_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_template FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_template_workspace_isolation ON email_template;
CREATE POLICY email_template_workspace_isolation ON email_template
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP TRIGGER IF EXISTS email_template_set_updated_at ON email_template;
CREATE TRIGGER email_template_set_updated_at BEFORE UPDATE ON email_template
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- email_template_version — WORKSPACE-scoped, append-only (no updated_at trigger)
ALTER TABLE email_template_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_template_version FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_template_version_workspace_isolation ON email_template_version;
CREATE POLICY email_template_version_workspace_isolation ON email_template_version
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON sending_domain, mailbox_integration, email_event TO leadwolf_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON email_template, email_template_version TO leadwolf_app;
