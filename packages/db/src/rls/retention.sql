-- retention.sql — access model for the per-data-class RETENTION engine control plane (data-management backlog
-- #6; design 16-retention-engine-design.md, spec 08-compliance §7 + ADR-0025). Applied after the Drizzle
-- migration (0025) creates the tables; idempotent (DROP-before-CREATE), re-run on every migrate.
--
-- ACCESS MODEL (the load-bearing part of this unit):
--   • retention_policies is GLOBAL + platform-managed — NOT tenant-scoped. The customer app role (leadwolf_app)
--     READS the policies to evaluate retention in-request, but NEVER writes them; policy changes happen on the
--     table-owner / withPlatformTx path (the future admin surface). So: a SELECT-only policy + NO write policy
--     — identical to feature_flags (rls/featureFlags.sql) and dsar_requests (rls/compliance.sql).
--   • retention_runs is per-tenant + APPEND-ONLY — tenant-scoped RLS keyed on tenant_id; leadwolf_app reads its
--     OWN tenant's run audit and APPENDS new runs under withTenantTx (the sweep records one row per class/run).
--     It must never UPDATE or DELETE a run (the audit trail is immutable).
--
-- THE WRITE GUARANTEE is FORCE ROW LEVEL SECURITY + the per-command policy SET — NOT the GRANTs below. Under
-- FORCE RLS a command is denied unless a policy permits it, EVEN THOUGH applyMigrations' blanket
-- `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES TO leadwolf_app` (the [4/4] grants phase, run AFTER this
-- file) hands the app role every table privilege. So:
--   • retention_policies has ONLY a SELECT policy → the app role can never INSERT/UPDATE/DELETE a policy row.
--   • retention_runs has ONLY a SELECT + an INSERT policy (no UPDATE/DELETE policy) → the app role can read and
--     append its own tenant's runs but can never mutate or remove one. This is the exact policy-absence wall
--     proven for feature_flags' writes; the GRANTs below are the documentary, defense-in-depth expression of it.
-- The owner / leadwolf_admin (BYPASSRLS) path used by withPlatformTx is unaffected and reads/writes both tables.

-- ── retention_policies — global, read-only for the app role ─────────────────────────────────────────────────
ALTER TABLE retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_policies FORCE ROW LEVEL SECURITY;

-- The app role may READ every global policy (defaults gate retention for all tenants). No write policy exists,
-- so under FORCE RLS the app role can never INSERT/UPDATE/DELETE a row — policy edits are platform-only.
DROP POLICY IF EXISTS retention_policies_app_read ON retention_policies;
CREATE POLICY retention_policies_app_read ON retention_policies FOR SELECT USING (true);

-- ── retention_runs — per-tenant, tenant-scoped read + append for the app role (append-only) ─────────────────
ALTER TABLE retention_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_runs FORCE ROW LEVEL SECURITY;

-- The app role reads ONLY its active tenant's run audit (the GUC set by withTenantTx).
DROP POLICY IF EXISTS retention_runs_tenant_read ON retention_runs;
CREATE POLICY retention_runs_tenant_read ON retention_runs FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- …and APPENDS new runs for its active tenant only (WITH CHECK pins the row to the GUC tenant). There is
-- deliberately NO UPDATE and NO DELETE policy → under FORCE RLS those commands are denied for the app role,
-- so the run audit is immutable (append-only) regardless of the blanket table grant.
DROP POLICY IF EXISTS retention_runs_tenant_insert ON retention_runs;
CREATE POLICY retention_runs_tenant_insert ON retention_runs FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Documentary / defense-in-depth grants (the real walls are the policies above; the [4/4] blanket grant runs
-- after this file and re-widens leadwolf_app, so these GRANTs state intent rather than restrict on their own).
GRANT SELECT ON retention_policies TO leadwolf_app;
GRANT SELECT, INSERT ON retention_runs TO leadwolf_app;
