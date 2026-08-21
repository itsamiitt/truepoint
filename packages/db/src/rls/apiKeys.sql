-- apiKeys.sql — RLS for api_keys (machine credentials, 09 §4 / ADR-0049). Applied after the Drizzle table
-- migration by applyMigrations (it runs every src/rls/*.sql); idempotent (DROP POLICY IF EXISTS).
--
-- TENANT-scoped, ENABLE + FORCE — the same posture as rls/scim.sql, and for the same reason: the management
-- surface (Settings ▸ Developer ▸ API keys) runs as a security_admin/owner through the non-BYPASSRLS
-- leadwolf_app role, so FORCE is required. A forgotten tenant filter returns nothing, never another org's
-- credentials.
--
-- WHY NOT ALSO A WORKSPACE PREDICATE. api_keys carries workspace_id, but the policy scopes on tenant_id only.
-- Key management is a TENANT-level duty (ADR-0030 gives it to security_admin, who is not necessarily a member
-- of every workspace), so a workspace predicate would hide a tenant's own keys from the person responsible for
-- rotating them. The workspace_id on the row is what the KEY acts as at call time, not who may administer it.
--
-- THE AUTHENTICATION READ DELIBERATELY BYPASSES THIS. apiKeyRepository.findActiveByHash runs under
-- withPrivilegedTx, because a presented key's tenant is unknown until the hash resolves — there is no GUC to
-- set yet. That is safe because key_hash is GLOBALLY UNIQUE, so a hash matches at most one row across all
-- tenants, and the tenant is learned FROM that row and then scopes everything downstream. Same shape as
-- scimTokenRepository.findActiveByHash and userRepository.findByEmail.

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS api_keys_tenant_isolation ON api_keys;
CREATE POLICY api_keys_tenant_isolation ON api_keys
  USING (tenant_id = (SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid));

GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys TO leadwolf_app;

-- ── api_key_usage_daily ─────────────────────────────────────────────────────────────────────────────────
-- Same tenant posture, and FORCE for the same reason: the usage dashboard reads it through leadwolf_app on
-- the customer's behalf, and the metering upsert writes it on the API path under the key's resolved tenant.
-- Both sides are the app role, so a missing predicate must return nothing rather than another org's spend.
--
-- No DELETE grant. Usage is a record a customer reconciles an invoice against; nothing in the product has a
-- reason to remove a row, and the absence of the grant is what makes that true rather than merely intended.
-- (Tenant deletion still cascades via the FK, which runs as the owner.)
ALTER TABLE api_key_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_key_usage_daily FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS api_key_usage_daily_tenant_isolation ON api_key_usage_daily;
CREATE POLICY api_key_usage_daily_tenant_isolation ON api_key_usage_daily
  USING (tenant_id = (SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid));

GRANT SELECT, INSERT, UPDATE ON api_key_usage_daily TO leadwolf_app;
