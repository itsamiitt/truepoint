-- auth.sql — Row-Level Security for the tenancy/auth tables (03 §9, ADR-0006). Applied after the Drizzle
-- migration creates the tables. Policies key off transaction-LOCAL GUCs set by withTenantTx() under a
-- NON-BYPASSRLS application role; NULLIF(current_setting(..., true), '') treats unset AND ''-reset GUCs as no-scope, so an unscoped
-- query reads nothing. RDS Proxy resets GUCs per checkout, hence they are set inside the transaction.

-- Required extensions (idempotent). uuid_generate_v7 comes from pg_uuidv7; fall back to an app function
-- if the extension is unavailable in the target environment.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- uuid_generate_v7(): prefer the pg_uuidv7 extension in production; this pure-SQL fallback keeps the
-- v7 column defaults working on stock PostgreSQL 16 (local/dev). Time-ordered for index locality (03 §2).
CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid())
          PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
          FROM 1 FOR 6),
        52, 1),
      53, 1),
    'hex')::uuid;
$$ LANGUAGE sql VOLATILE;

-- Tenant-scoped tables: isolated by app.current_tenant_id. DROP-before-CREATE keeps this file idempotent —
-- applyMigrations re-runs every rls/*.sql on each migrate, so a plain CREATE POLICY would fail on re-run
-- (42710 "policy already exists"). Mirrors the DROP POLICY IF EXISTS pattern in the other rls/*.sql files.
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspaces_tenant_isolation ON workspaces;
CREATE POLICY workspaces_tenant_isolation ON workspaces
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS members_tenant_isolation ON workspace_members;
CREATE POLICY members_tenant_isolation ON workspace_members
  USING (workspace_id IN (
    SELECT id FROM workspaces WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ));

-- USING + WITH CHECK on all three: the Auth Admin now WRITES these under the app role (withTenantTx), so the
-- write side must also be constrained to the active tenant (defence-in-depth — the app role can't stamp a row
-- with another tenant's id). The auth service's pre-tenant provisioning runs on the owner connection, which
-- ENABLE (not FORCE) RLS leaves exempt.
ALTER TABLE tenant_domains ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_domains_isolation ON tenant_domains;
CREATE POLICY tenant_domains_isolation ON tenant_domains
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE tenant_sso_configs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_sso_isolation ON tenant_sso_configs;
CREATE POLICY tenant_sso_isolation ON tenant_sso_configs
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE tenant_auth_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_auth_policy_isolation ON tenant_auth_policies;
CREATE POLICY tenant_auth_policy_isolation ON tenant_auth_policies
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- tenant_members + invitations: tenant-scoped for the app role (read under withTenantTx).
ALTER TABLE tenant_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_members_isolation ON tenant_members;
CREATE POLICY tenant_members_isolation ON tenant_members
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invitations_isolation ON invitations;
CREATE POLICY invitations_isolation ON invitations
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Global identity (ADR-0019): `users` is NOT tenant-RLS-scoped — one row per person, read by the auth service
-- before any tenant is chosen. The auth service also reads the membership graph (`tenant_members` by user_id)
-- and verified `tenant_domains` PRE-tenant under its own (privileged) connection; the customer app's
-- non-BYPASSRLS `leadwolf_app` role only ever sees rows for the active tenant via the GUC above. The
-- user-scoped auth tables (`user_sessions`/`user_mfa_methods`/`trusted_devices`/`auth_email_tokens`) are
-- likewise auth-service-owned, keyed by user_id.
