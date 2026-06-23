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

CREATE TABLE IF NOT EXISTS platform_audit_log (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  actor_user_id uuid NOT NULL,
  action text NOT NULL,
  target_type text,
  target_id text,
  tenant_id uuid,
  workspace_id uuid,
  ip text,
  metadata jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

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
