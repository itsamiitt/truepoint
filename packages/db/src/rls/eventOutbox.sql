-- eventOutbox.sql — RLS for the domain-event outbox (reveal-experience Phase 4). ENABLE (not FORCE) +
-- workspace-scoped policy: the app role (leadwolf_app) may only INSERT/SELECT rows for its own workspace
-- (a writer appends inside withTenantTx → the WITH CHECK matches the current_workspace_id GUC). The relay
-- runs on the OWNER connection (no GUC) and, because RLS is ENABLE-not-FORCE, bypasses the policy to drain
-- pending rows across ALL workspaces and mark them published. Idempotent — safe to re-run every migrate.

ALTER TABLE event_outbox ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS event_outbox_workspace_isolation ON event_outbox;
CREATE POLICY event_outbox_workspace_isolation ON event_outbox
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON event_outbox TO leadwolf_app;
