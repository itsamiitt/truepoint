-- activity.sql — RLS + the recency-sync trigger for the activity timeline (03 §7, 05 §10, M8).
-- Workspace-scoped like contacts; policies use the NULLIF idiom so unset/reset GUCs fail closed.
-- Idempotent — safe to re-run on every migrate.

ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS activities_workspace_isolation ON activities;
CREATE POLICY activities_workspace_isolation ON activities
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

-- Recency sync (03 §7, 05 §10): contacts.last_activity_at is a CACHE of the newest occurred_at — kept by
-- trigger so it holds regardless of caller. Backfilled (older) activities never regress it.
CREATE OR REPLACE FUNCTION sync_last_activity() RETURNS trigger AS $$
BEGIN
  UPDATE contacts SET last_activity_at = NEW.occurred_at
   WHERE id = NEW.contact_id
     AND (last_activity_at IS NULL OR last_activity_at < NEW.occurred_at);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS activities_sync_last_activity ON activities;
CREATE TRIGGER activities_sync_last_activity AFTER INSERT ON activities
  FOR EACH ROW EXECUTE FUNCTION sync_last_activity();

GRANT SELECT, INSERT, UPDATE, DELETE ON activities TO leadwolf_app;
