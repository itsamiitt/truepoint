-- platform.sql — lock down platform_audit_log, the cross-tenant STAFF audit trail (ADR-0032, 13 §11).
-- Previously this table was created only in bootstrapAdmin.ts with NO RLS, and the blanket GRANT in
-- applyMigrations gave the customer app role (leadwolf_app) full read/write — so the app role could read or
-- tamper the platform audit trail. This file is the fix.
--
-- It is created HERE (idempotent CREATE IF NOT EXISTS) because provisionBootstrapAdmin runs AFTER
-- applyMigrations, so the migrate flow itself must own the table for the lockdown to apply on every DB.
--
-- Posture: it is written ONLY by the table-owner connection (withPlatformTx in client.ts; no SET LOCAL
-- ROLE). So RLS is ENABLE (NOT FORCE): FORCE would subject the owner to RLS and block the audit write —
-- the same reasoning billing.sql documents for tenants/purchases. With ENABLE + NO policy, the owner writer
-- is exempt while leadwolf_app (a non-owner, policy-subject role) sees zero rows and cannot write. The
-- blanket table GRANT to leadwolf_app is additionally REVOKED in the applyMigrations grants phase
-- (defence-in-depth). UPDATE/DELETE raise for EVERY role via the append-only trigger. Idempotent.

-- PARTITIONED by month on occurred_at (E-6.4). The primary key is composite because a partitioned table's
-- unique constraints must include the partition key; nothing references this table, so that is a widening.
-- On a FRESH database this file creates it partitioned from the start; on an EXISTING one migration 0086
-- converts it before this file runs. Both paths converge on the same shape.
CREATE TABLE IF NOT EXISTS platform_audit_log (
  id uuid NOT NULL DEFAULT uuid_generate_v7(),
  actor_user_id uuid NOT NULL,
  action text NOT NULL,
  target_type text,
  target_id text,
  tenant_id uuid,
  workspace_id uuid,
  ip text,
  metadata jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- The catch-all plus the sweep's horizon. Without a partition covering "now" the FIRST audit write fails, and
-- an audit trail that refuses writes is worse than one that is slow — withPlatformTx would start erroring.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'platform_audit_log_default'
       AND relnamespace = 'public'::regnamespace
  ) THEN
    CREATE TABLE platform_audit_log_default PARTITION OF platform_audit_log DEFAULT;
  END IF;
  PERFORM ensure_month_partitions('platform_audit_log'::regclass, 3);
END $$;

-- Index the customer-visible-access-log read (list-plan/07 §5): the customer's staff-access view filters
-- `WHERE tenant_id = $1 ... ORDER BY occurred_at DESC`. Without this, that tenant-admin read is a full scan +
-- sort over the cross-tenant trail (which grows with EVERY withPlatformTx action). Partial on tenant_id IS
-- NOT NULL so it stays small (most platform actions are tenant-targeted; tenant-less rows are excluded).
CREATE INDEX IF NOT EXISTS idx_platform_audit_tenant_time
  ON platform_audit_log (tenant_id, occurred_at DESC)
  WHERE tenant_id IS NOT NULL;

-- ENABLE (not FORCE): the owner connection that runs withPlatformTx must keep writing; leadwolf_app is a
-- non-owner policy-subject, and with NO policy it is denied every row and every write — deny-all.
ALTER TABLE platform_audit_log ENABLE ROW LEVEL SECURITY;

-- Append-only for EVERY role (owner included): the audit trail can be inserted but never mutated/erased.
CREATE OR REPLACE FUNCTION platform_audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_log is append-only (ADR-0032)';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS platform_audit_log_no_mutation ON platform_audit_log;
CREATE TRIGGER platform_audit_log_no_mutation BEFORE UPDATE OR DELETE ON platform_audit_log
  FOR EACH ROW EXECUTE FUNCTION platform_audit_log_append_only();

-- ── platform_staff — granular platform STAFF roles (ADR-0011, Phase 1). PLATFORM-owned: written by the
-- owner / withPlatformTx and read for authz on the owner connection; the customer app role must NOT see who
-- can operate the platform. Same posture as platform_audit_log — ENABLE (not FORCE) RLS + NO policy denies
-- leadwolf_app while the owner reads/writes — but MUTABLE (grant/revoke), so NO append-only trigger. The
-- table + tenant_members.org_role are created by the Drizzle migration; this file applies RLS, the DB-level
-- role CHECKs (no ALTER TYPE — varchar + CHECK), and the idempotent backfills from the legacy booleans.
ALTER TABLE platform_staff ENABLE ROW LEVEL SECURITY;

-- Constrain the role vocabularies at the DB (mirror the @leadwolf/types orgRole/staffRole enums).
ALTER TABLE tenant_members DROP CONSTRAINT IF EXISTS tenant_members_org_role_check;
ALTER TABLE tenant_members ADD CONSTRAINT tenant_members_org_role_check
  CHECK (org_role IN ('owner', 'billing_admin', 'security_admin', 'compliance_admin', 'member'));
ALTER TABLE platform_staff DROP CONSTRAINT IF EXISTS platform_staff_role_check;
ALTER TABLE platform_staff ADD CONSTRAINT platform_staff_role_check
  CHECK (staff_role IN ('super_admin', 'support', 'billing_ops', 'compliance_officer', 'read_only', 'data_ops'));

-- Backfill the granular roles from the legacy booleans (idempotent): every is_tenant_owner member becomes
-- org_role 'owner'; every is_platform_admin user becomes an active super_admin staff row.
UPDATE tenant_members SET org_role = 'owner' WHERE is_tenant_owner = true AND org_role <> 'owner';
INSERT INTO platform_staff (user_id, staff_role, status)
  SELECT id, 'super_admin', 'active' FROM users WHERE is_platform_admin = true
  ON CONFLICT (user_id) DO NOTHING;
