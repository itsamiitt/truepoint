-- watchlists.sql — RLS for watchlists + members + signal subscriptions (market-intelligence MI-S5).
-- Workspace-scoped, NULLIF fail-closed like intel.sql/tenantSignals.sql. Per-USER visibility of a
-- subscription is repo-enforced (the GUC carries no user id — same posture as notifications).
-- Idempotent — safe to re-run on every migrate.

ALTER TABLE watchlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE watchlists FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS watchlists_workspace_isolation ON watchlists;
CREATE POLICY watchlists_workspace_isolation ON watchlists
  USING (workspace_id = (SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (workspace_id = (SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE watchlist_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE watchlist_members FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS watchlist_members_workspace_isolation ON watchlist_members;
CREATE POLICY watchlist_members_workspace_isolation ON watchlist_members
  USING (workspace_id = (SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (workspace_id = (SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE signal_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE signal_subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS signal_subscriptions_workspace_isolation ON signal_subscriptions;
CREATE POLICY signal_subscriptions_workspace_isolation ON signal_subscriptions
  USING (workspace_id = (SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (workspace_id = (SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid));

GRANT SELECT, INSERT, UPDATE, DELETE ON watchlists, watchlist_members, signal_subscriptions TO leadwolf_app;
