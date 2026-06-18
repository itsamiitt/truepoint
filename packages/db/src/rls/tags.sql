-- tags.sql — Row-Level Security + updated_at trigger for the record-customization tag layer
-- (tags, record_tags — ADR-0028, G-REV-6). Applied after the Drizzle migration creates the tables.
-- Workspace-scoped like contacts: policies key off the transaction-LOCAL GUC app.current_workspace_id set
-- by withTenantTx() under the NON-BYPASSRLS leadwolf_app role. NULLIF(current_setting(..., true), '')
-- treats unset AND ''-reset GUCs as no-scope, so an unscoped query reads/writes nothing (fail-closed).
-- Idempotent: safe to re-run on every migrate. (set_updated_at() is defined in contacts.sql, applied first.)

-- ── tags ───────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tags_workspace_isolation ON tags;
CREATE POLICY tags_workspace_isolation ON tags
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
DROP TRIGGER IF EXISTS tags_set_updated_at ON tags;
CREATE TRIGGER tags_set_updated_at BEFORE UPDATE ON tags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── record_tags ────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE record_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_tags FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS record_tags_workspace_isolation ON record_tags;
CREATE POLICY record_tags_workspace_isolation ON record_tags
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON tags, record_tags TO leadwolf_app;
