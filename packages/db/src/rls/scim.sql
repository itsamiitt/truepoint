-- scim.sql — RLS for scim_tokens (enterprise IAM, 17 / ADR-0018). Applied after the Drizzle migration by
-- applyMigrations (it runs every src/rls/*.sql); idempotent (DROP POLICY IF EXISTS). TENANT-scoped: a
-- security_admin/owner manages their OWN org's SCIM tokens through the leadwolf_app (non-BYPASSRLS) role, so
-- FORCE is required — a forgotten tenant filter returns nothing, never another org's tokens. Mirrors the
-- contact_reveals block in rls/billing.sql (ENABLE + FORCE + USING + WITH CHECK on the scope column + GRANT).

ALTER TABLE scim_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE scim_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scim_tokens_tenant_isolation ON scim_tokens;
CREATE POLICY scim_tokens_tenant_isolation ON scim_tokens
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON scim_tokens TO leadwolf_app;
