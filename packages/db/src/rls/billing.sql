-- billing.sql — RLS + triggers for the M3 money loop (contact_reveals, purchases, stripe_customers,
-- suppression_list, idempotency_keys, audit_log) and the tenant-counter isolation the reveal transaction
-- relies on (03 §8/§9/§10, 07 §3, ADR-0007). Applied after the Drizzle migration; idempotent.

-- ── tenants — the credit counter row. The reveal tx runs SELECT…FOR UPDATE + UPDATE on tenants under the
-- non-BYPASSRLS leadwolf_app role, so leadwolf_app must see ONLY the active tenant's row. ENABLE (not
-- FORCE): the auth service provisions tenants pre-tenant-context on the table-owner connection, which a
-- FORCE policy would block (auth.sql documents that posture).
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_self ON tenants;
CREATE POLICY tenants_self ON tenants
  USING (id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Overdraft is impossible at the DB layer regardless of caller (07 §3 required mitigation).
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_credit_nonnegative;
ALTER TABLE tenants ADD CONSTRAINT tenants_credit_nonnegative CHECK (reveal_credit_balance >= 0);

-- ── contact_reveals — workspace-scoped like contacts ────────────────────────────────────────────────────
ALTER TABLE contact_reveals ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_reveals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_reveals_workspace_isolation ON contact_reveals;
CREATE POLICY contact_reveals_workspace_isolation ON contact_reveals
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

-- Reveal ownership: the FIRST contact_reveals row for a (workspace, contact) flips the contact's
-- is_revealed/revealed_by/revealed_at — idempotent, first-wins. The credit charge is NOT here: it happens
-- in the app reveal transaction against tenants.reveal_credit_balance (03 §10).
CREATE OR REPLACE FUNCTION set_reveal_ownership() RETURNS trigger AS $$
BEGIN
  UPDATE contacts
     SET is_revealed = TRUE,
         revealed_by_user_id = NEW.revealed_by_user_id,
         revealed_at = NEW.revealed_at
   WHERE id = NEW.contact_id AND is_revealed = FALSE;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS contact_reveals_set_ownership ON contact_reveals;
CREATE TRIGGER contact_reveals_set_ownership AFTER INSERT ON contact_reveals
  FOR EACH ROW EXECUTE FUNCTION set_reveal_ownership();

-- ── purchases + stripe_customers — tenant-scoped reads; writes come from the Stripe-webhook system path
-- on the table-owner connection (pre-tenant scope), so ENABLE without FORCE (mirrors the tenants posture).
ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purchases_tenant_isolation ON purchases;
CREATE POLICY purchases_tenant_isolation ON purchases
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE stripe_customers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stripe_customers_tenant_isolation ON stripe_customers;
CREATE POLICY stripe_customers_tenant_isolation ON stripe_customers
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- ── suppression_list — readable across its three scopes from a workspace tx (global rows are visible to
-- everyone; that is the point of a global DNC). Writes from the app role only at tenant/workspace scope —
-- global rows are platform-managed (13/ADR-0011).
ALTER TABLE suppression_list ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppression_list FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS suppression_read ON suppression_list;
CREATE POLICY suppression_read ON suppression_list FOR SELECT
  USING (
    scope = 'global'
    OR (scope = 'tenant' AND tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    OR (scope = 'workspace' AND workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  );
DROP POLICY IF EXISTS suppression_write ON suppression_list;
CREATE POLICY suppression_write ON suppression_list FOR INSERT
  WITH CHECK (
    (scope = 'tenant' AND tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    OR (scope = 'workspace' AND workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  );
DROP POLICY IF EXISTS suppression_delete ON suppression_list;
CREATE POLICY suppression_delete ON suppression_list FOR DELETE
  USING (
    (scope = 'tenant' AND tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    OR (scope = 'workspace' AND workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  );

-- ── idempotency_keys — tenant-scoped replay store ───────────────────────────────────────────────────────
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS idempotency_tenant_isolation ON idempotency_keys;
CREATE POLICY idempotency_tenant_isolation ON idempotency_keys
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- ── audit_log — append-only (08 §5). Tenant-scoped read/insert for the app role; UPDATE/DELETE raise for
-- EVERY role via trigger (order-independent of the blanket GRANTs in applyMigrations; M5 finalizes).
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_tenant_isolation ON audit_log;
CREATE POLICY audit_tenant_isolation ON audit_log
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (08 §5)';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_log_no_mutation ON audit_log;
CREATE TRIGGER audit_log_no_mutation BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

GRANT SELECT, INSERT, UPDATE, DELETE
  ON contact_reveals, purchases, stripe_customers, suppression_list, idempotency_keys TO leadwolf_app;
GRANT SELECT, INSERT ON audit_log TO leadwolf_app;
GRANT SELECT, UPDATE ON tenants TO leadwolf_app;
