-- auth.sql — Row-Level Security for the tenancy/auth tables (03 §9, ADR-0006). Applied after the Drizzle
-- migration creates the tables. Policies key off transaction-LOCAL GUCs set by withTenantTx() under a
-- NON-BYPASSRLS application role; current_setting(..., true) returns NULL when unset, so an unscoped
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

-- Tenant-scoped tables: isolated by app.current_tenant_id.
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspaces_tenant_isolation ON workspaces
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY members_tenant_isolation ON workspace_members
  USING (workspace_id IN (
    SELECT id FROM workspaces WHERE tenant_id = current_setting('app.current_tenant_id', true)::uuid
  ));

ALTER TABLE tenant_domains ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_domains_isolation ON tenant_domains
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE tenant_sso_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_sso_isolation ON tenant_sso_configs
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE tenant_auth_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_auth_policy_isolation ON tenant_auth_policies
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_tenant_isolation ON users
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Auth-service boundary (17 §1): the identifier-first lookup must read `users` / `user_sessions` /
-- `user_mfa_methods` / `trusted_devices` BEFORE any tenant context exists. Those reads run as the
-- dedicated auth-service role (apps/auth), not the app's tenant-scoped role; a permissive policy for that
-- role (and the user_id-scoped policies for the session/MFA/device tables) is granted in the auth-role
-- migration, kept separate from the customer app's non-BYPASSRLS role.
