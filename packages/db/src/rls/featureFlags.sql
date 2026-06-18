-- featureFlags.sql — access model for the platform feature-flag system (13 §3.5, ADR-0011). Applied after
-- the Drizzle migration creates the tables; idempotent (DROP-before-CREATE), re-run on every migrate.
--
-- ACCESS MODEL (the load-bearing part of this unit):
--   • feature_flags is GLOBAL + platform-managed — NOT workspace-scoped. ALL writes happen on the table-
--     owner connection via the audited withPlatformTx path (apps/admin / the internal /admin/* API). The
--     customer app role (leadwolf_app) must NEVER write it, but it DOES need to READ the global defaults to
--     evaluate flags in-request. So: a SELECT-only policy + NO write policy.
--   • tenant_feature_flags is per-tenant — tenant-scoped RLS keyed on tenant_id; leadwolf_app reads its OWN
--     tenant's overrides under withTenantTx for evaluation. Writes (admin toggles) again go through the
--     owner/withPlatformTx path; the app role gets no write policy.
--
-- THE WRITE GUARANTEE is FORCE ROW LEVEL SECURITY + the ABSENCE of any write (INSERT/UPDATE/DELETE) policy:
-- under FORCE RLS the app role cannot write a single row even though applyMigrations' blanket
-- `GRANT ... ON ALL TABLES TO leadwolf_app` (run in a LATER phase) hands it table privileges. This is the
-- exact, proven posture used for the platform-owned dsar_requests table (see rls/compliance.sql). The
-- owner / leadwolf_admin (BYPASSRLS) path used by withPlatformTx is unaffected and reads/writes both tables.

-- ── feature_flags — global, read-only for the app role ────────────────────────────────────────────────────
ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_flags FORCE ROW LEVEL SECURITY;

-- The app role may READ every global flag (defaults gate features for all tenants). No write policy exists,
-- so under FORCE RLS the app role can never INSERT/UPDATE/DELETE a row — writes are platform-only.
DROP POLICY IF EXISTS feature_flags_app_read ON feature_flags;
CREATE POLICY feature_flags_app_read ON feature_flags FOR SELECT USING (true);

-- ── tenant_feature_flags — per-tenant overrides, tenant-scoped read for the app role ─────────────────────
ALTER TABLE tenant_feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_feature_flags FORCE ROW LEVEL SECURITY;

-- The app role reads ONLY its active tenant's overrides (the GUC set by withTenantTx). No write policy →
-- the app role can never insert/update/delete an override; toggles go through the audited platform path.
DROP POLICY IF EXISTS tenant_feature_flags_read ON tenant_feature_flags;
CREATE POLICY tenant_feature_flags_read ON tenant_feature_flags FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
