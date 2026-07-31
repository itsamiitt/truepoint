-- usageEvents.sql — Row-Level Security for `usage_event` (Phase 1 outcome-metric substrate). Workspace-scoped
-- exactly like ai_requests/notifications/contacts: the policy keys off the transaction-LOCAL GUC
-- app.current_workspace_id set by withTenantTx() under the NON-BYPASSRLS leadwolf_app role.
-- NULLIF(current_setting(..., true), '') treats an unset OR ''-reset GUC as no-scope, so an unscoped query
-- reads nothing — fail-closed. Platform staff read CROSS-TENANT on the owner connection (BYPASSRLS), which
-- this policy does not constrain.
--
-- FORCE, not merely ENABLE: usage_event is written on the app path, so the owner has no legitimate reason to
-- bypass row scoping here — unlike credit_ledger, where the Stripe-grant webhook genuinely runs unscoped.
--
-- UPDATE/DELETE are granted for parity with ai_requests and for retention pruning. There is no append-only
-- trigger here, deliberately: usage_event is a METRIC surface, not evidence. The evidence table is
-- provenance_event, which IS append-only and which nothing on this path can reach.

ALTER TABLE usage_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS usage_event_workspace_isolation ON usage_event;
CREATE POLICY usage_event_workspace_isolation ON usage_event
  USING (workspace_id = (SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (workspace_id = (SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE, DELETE ON usage_event TO leadwolf_app;
