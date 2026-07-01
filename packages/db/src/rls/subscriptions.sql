-- subscriptions.sql — RLS for `subscriptions` + `billing_cycles` (M11, ADR-0041). TENANT data (posture A) like
-- purchases: ENABLE (not FORCE) so the SYSTEM writers (the Stripe webhook + the monthly-grant/reset worker) run
-- on the owner connection with no tenant GUC, while the non-BYPASSRLS leadwolf_app customer role reads ONLY its
-- own tenant's rows (app.current_tenant_id; NULLIF(...) = fail-closed). Writes are system/owner-path only —
-- leadwolf_app gets SELECT (the billing hub reads the subscription + cycle history). A granted billing_cycle is
-- immutable (a trigger blocks UPDATE/DELETE once granted_at is set — grant integrity).

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subscriptions_tenant_isolation ON subscriptions;
CREATE POLICY subscriptions_tenant_isolation ON subscriptions
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE billing_cycles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_cycles_tenant_isolation ON billing_cycles;
CREATE POLICY billing_cycles_tenant_isolation ON billing_cycles
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- A granted billing_cycle is immutable (grant integrity, ADR-0041): block any UPDATE/DELETE once granted_at is
-- set; an un-granted cycle may still transition (open → granted by the worker).
CREATE OR REPLACE FUNCTION billing_cycles_grant_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.granted_at IS NOT NULL THEN
    RAISE EXCEPTION 'a granted billing_cycle is immutable (ADR-0041)';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS billing_cycles_no_regrant ON billing_cycles;
CREATE TRIGGER billing_cycles_no_regrant BEFORE UPDATE OR DELETE ON billing_cycles
  FOR EACH ROW EXECUTE FUNCTION billing_cycles_grant_immutable();

GRANT SELECT ON subscriptions, billing_cycles TO leadwolf_app;
