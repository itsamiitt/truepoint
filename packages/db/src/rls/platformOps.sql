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
