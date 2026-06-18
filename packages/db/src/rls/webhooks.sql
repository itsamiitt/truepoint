-- webhooks.sql — Row-Level Security for outbound webhooks (09 §10, M10). Workspace-scoped like contacts:
-- both webhook_subscriptions and webhook_deliveries carry workspace_id directly, so each gets a direct
-- isolation policy. Policies key off the transaction-LOCAL GUC app.current_workspace_id set by withTenantTx()
-- under the NON-BYPASSRLS leadwolf_app role; NULLIF(current_setting(..., true), '') treats unset AND
-- ''-reset GUCs as no-scope, so an unscoped query reads nothing (fail-closed). Idempotent: safe to re-run.

-- ── webhook_subscriptions ───────────────────────────────────────────────────────────────────────────────
ALTER TABLE webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhook_subscriptions_workspace_isolation ON webhook_subscriptions;
CREATE POLICY webhook_subscriptions_workspace_isolation ON webhook_subscriptions
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

-- ── webhook_deliveries ──────────────────────────────────────────────────────────────────────────────────
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhook_deliveries_workspace_isolation ON webhook_deliveries;
CREATE POLICY webhook_deliveries_workspace_isolation ON webhook_deliveries
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_subscriptions, webhook_deliveries TO leadwolf_app;
