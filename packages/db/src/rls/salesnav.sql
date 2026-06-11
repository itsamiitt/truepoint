-- salesnav.sql — RLS for Sales Navigator link capture (05 §5, M7, ADR-0009 HITL). Workspace-scoped like
-- contacts; policies use the NULLIF idiom so unset/reset GUCs fail closed. Idempotent — safe to re-run
-- on every migrate.

ALTER TABLE sales_nav_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_nav_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_nav_links_workspace_isolation ON sales_nav_links;
CREATE POLICY sales_nav_links_workspace_isolation ON sales_nav_links
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON sales_nav_links TO leadwolf_app;
