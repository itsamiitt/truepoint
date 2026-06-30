-- platformOps.sql — lock down impersonation_sessions, the cross-tenant STAFF impersonation audit-of-record
-- (ADR-0011, 13 §11). Same posture as platform_staff / platform_audit_log in rls/platform.sql.
--
-- The table is created by the Drizzle migration (the lead generates it). This file applies the RLS lockdown
-- on every DB; it runs in the migrate flow so the posture is guaranteed regardless of how the row was made.
--
-- Posture: it is written ONLY by the table-owner connection (withPlatformTx in client.ts; no SET LOCAL
-- ROLE). So RLS is ENABLE (NOT FORCE): FORCE would subject the owner to RLS and block the audit write — the
-- same reasoning platform.sql documents for platform_staff / platform_audit_log. With ENABLE + NO policy,
-- the owner writer is exempt while leadwolf_app (a non-owner, policy-subject role) sees zero rows and cannot
-- write — deny-all. The blanket table GRANT to leadwolf_app is additionally REVOKED in the applyMigrations
-- grants phase (defence-in-depth; the lead adds `REVOKE ALL ON impersonation_sessions FROM leadwolf_app;`).
-- This table is MUTABLE (a session is ended → ended_at set), so — unlike platform_audit_log — there is NO
-- append-only trigger. Idempotent (CREATE/ALTER are guarded; running this repeatedly is a no-op).

-- Defensive: ensure the table exists before ALTER so this file is safe to run standalone (the migration
-- owns the canonical column set; this matches its shape). No-op once the migration has created it.
CREATE TABLE IF NOT EXISTS impersonation_sessions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  staff_user_id uuid NOT NULL,
  target_tenant_id uuid NOT NULL,
  target_workspace_id uuid,
  target_user_id uuid,
  reason text NOT NULL,
  expires_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  ip text
);

-- ENABLE (not FORCE): the owner connection that runs withPlatformTx must keep writing; leadwolf_app is a
-- non-owner policy-subject, and with NO policy it is denied every row and every write — deny-all.
ALTER TABLE impersonation_sessions ENABLE ROW LEVEL SECURITY;

-- jit_elevations (ADR-0011, 13a F1) — just-in-time elevation grants, the same PLATFORM-owned staff posture as
-- impersonation_sessions above. Written ONLY by the owner connection (withPlatformTx); leadwolf_app must never
-- read who is elevated for what. ENABLE (not FORCE) keeps the owner writer exempt while the policy-subject app
-- role sees zero rows; the blanket grant is additionally REVOKED in applyMigrations (defence-in-depth). MUTABLE
-- (status active → consumed), so no append-only trigger. Defensive CREATE mirrors the migration's column set so
-- this file is safe to run standalone; idempotent.
CREATE TABLE IF NOT EXISTS jit_elevations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  staff_user_id uuid NOT NULL,
  action text NOT NULL,
  reason text NOT NULL,
  target_tenant_id uuid,
  status text NOT NULL DEFAULT 'active',
  expires_at timestamptz NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  approved_by_user_id uuid,
  ip text
);

ALTER TABLE jit_elevations ENABLE ROW LEVEL SECURITY;

-- support_notes (13a Area 3) — internal staff notes about a tenant. Same PLATFORM-owned staff posture: written
-- only by the owner connection (withPlatformTx), deny-all to leadwolf_app so a customer can never read staff
-- notes about their org. ENABLE (not FORCE) + no policy = owner-exempt, app role denied; the applyMigrations
-- REVOKE removes the blanket grant too. Defensive CREATE mirrors the migration's column set; idempotent.
CREATE TABLE IF NOT EXISTS support_notes (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id uuid NOT NULL,
  staff_user_id uuid NOT NULL,
  body text NOT NULL,
  ticket_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE support_notes ENABLE ROW LEVEL SECURITY;

-- account_holds (13a Area 7) — staff abuse/fraud holds on a tenant. Same PLATFORM-owned posture: owner-written
-- (withPlatformTx), deny-all to leadwolf_app (this file + the applyMigrations REVOKE). Defensive CREATE mirrors
-- the migration's column set; idempotent.
CREATE TABLE IF NOT EXISTS account_holds (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id uuid NOT NULL,
  kind text NOT NULL,
  reason text NOT NULL,
  placed_by_user_id uuid NOT NULL,
  placed_at timestamptz NOT NULL DEFAULT now(),
  lifted_at timestamptz,
  lifted_by_user_id uuid
);

ALTER TABLE account_holds ENABLE ROW LEVEL SECURITY;

-- announcements (13a Area 10) — staff-authored banners. Owner-written (withPlatformTx), deny-all to
-- leadwolf_app (this file + the applyMigrations REVOKE). Customers read the active applicable ones through a
-- dedicated server-scoped api endpoint (owner connection, filtered to the caller's tenant), never this table.
-- Defensive CREATE mirrors the migration's column set; idempotent.
CREATE TABLE IF NOT EXISTS announcements (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  title text NOT NULL,
  body text NOT NULL,
  level text NOT NULL DEFAULT 'info',
  audience text NOT NULL DEFAULT 'all',
  tenant_target uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;

-- retention_policies (13a Area 8) — staff-authored retention SLAs. Owner-written (withPlatformTx), deny-all to
-- leadwolf_app (this file + the applyMigrations REVOKE). Defensive CREATE mirrors the migration; idempotent.
CREATE TABLE IF NOT EXISTS retention_policies (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  entity text NOT NULL,
  field text,
  retention_days integer NOT NULL,
  reason text,
  active boolean NOT NULL DEFAULT true,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE retention_policies ENABLE ROW LEVEL SECURITY;

-- credit_packs (13a Area 5) — staff-authored pricing config. Same PLATFORM-owned posture: written only by the
-- owner connection (withPlatformTx), deny-all to leadwolf_app for now (rls/platformOps.sql + applyMigrations
-- REVOKE). NOTE: the public, transparent pricing page (ADR-0012) is a SEPARATE customer read surface — when it
-- lands, add a SELECT policy for the active catalog and keep (not revoke) the leadwolf_app SELECT grant.
-- Defensive CREATE mirrors the migration's column set; idempotent.
CREATE TABLE IF NOT EXISTS credit_packs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  credits integer NOT NULL,
  price_cents integer NOT NULL,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE credit_packs ENABLE ROW LEVEL SECURITY;

-- plan_templates (13a Area 5) — staff-authored plan/entitlement config. Same PLATFORM-owned posture: written
-- only by the owner connection (withPlatformTx), deny-all to leadwolf_app (this file + the applyMigrations
-- REVOKE). Defensive CREATE mirrors the migration's column set; idempotent.
CREATE TABLE IF NOT EXISTS plan_templates (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  seat_limit integer NOT NULL,
  workspace_limit integer,
  monthly_credit_grant integer,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE plan_templates ENABLE ROW LEVEL SECURITY;

-- sub_processors (13a Area 8 / GDPR Art. 28) — staff-published sub-processor disclosure registry. Same
-- PLATFORM-owned posture: written only by the owner connection (withPlatformTx), deny-all to leadwolf_app (this
-- file + the applyMigrations REVOKE). A public Trust-Center read surface, when it lands, is a SEPARATE endpoint
-- (owner connection), never this table. Defensive CREATE mirrors the migration's column set; idempotent.
CREATE TABLE IF NOT EXISTS sub_processors (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  name text NOT NULL,
  purpose text NOT NULL,
  location text NOT NULL,
  dpa_url text,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sub_processors ENABLE ROW LEVEL SECURITY;
