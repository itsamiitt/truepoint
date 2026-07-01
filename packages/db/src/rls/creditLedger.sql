-- creditLedger.sql — RLS + append-only trigger for `credit_ledger` (M11, ADR-0029). The immutable credit
-- audit trail: one tenant-scoped entry per balance mutation. Tenant-scoped exactly like purchases/audit_log,
-- and ENABLE (NOT FORCE) for the same reason: the SYSTEM write paths (the Stripe-grant webhook + the signup
-- bonus) run on the table-OWNER connection with no tenant GUC, and a FORCE policy would BLOCK the owner (the
-- owner is subject to FORCE but bypasses ENABLE). The non-BYPASSRLS leadwolf_app customer role stays isolated
-- to its own tenant (app.current_tenant_id; NULLIF(..., '') = fail-closed) for both its credit-history read and
-- the in-tx reveal 'spend' insert. Append-only: UPDATE/DELETE raise for EVERY role via trigger (mirrors
-- audit_log) — refunds/reversals are NEW entries, never edits. Idempotent (DROP … IF EXISTS + CREATE).

ALTER TABLE credit_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS credit_ledger_tenant_isolation ON credit_ledger;
CREATE POLICY credit_ledger_tenant_isolation ON credit_ledger
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION credit_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger is append-only (ADR-0029)';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS credit_ledger_no_mutation ON credit_ledger;
CREATE TRIGGER credit_ledger_no_mutation BEFORE UPDATE OR DELETE ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_append_only();

GRANT SELECT, INSERT ON credit_ledger TO leadwolf_app;
