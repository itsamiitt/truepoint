-- activity.sql — RLS + the recency-sync trigger for the activity timeline (03 §7, 05 §10, M8).
-- Workspace-scoped like contacts; policies use the NULLIF idiom so unset/reset GUCs fail closed.
-- Idempotent — safe to re-run on every migrate.

ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS activities_workspace_isolation ON activities;
CREATE POLICY activities_workspace_isolation ON activities
  USING (workspace_id = (SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (workspace_id = (SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid));

-- Recency sync (03 §7, 05 §10): contacts.last_activity_at is a CACHE of the newest occurred_at — kept by
-- trigger so it holds regardless of caller. Backfilled (older) activities never regress it.
--
-- STATEMENT-level with a transition table, not FOR EACH ROW (C-3.12). The row-level version issued one
-- `UPDATE contacts` per inserted activity, so a bulk email-event ingest of N rows did N single-row UPDATEs —
-- and when several of those rows belonged to the same contact (the normal case: opens/clicks arrive batched
-- per contact) it also re-updated the SAME contact row repeatedly inside one statement, each write taking the
-- row lock and leaving another dead tuple for vacuum. Aggregating first collapses that to ONE UPDATE that
-- touches each affected contact exactly once, with max(occurred_at) per contact.
--
-- Semantics are unchanged: still newest-wins, and the `<` guard still means a backfilled (older) activity
-- never regresses the cache.
--
-- The trigger is dropped BEFORE the function is replaced: between the two statements the old row-level
-- trigger would otherwise be pointing at a body that references the `new_activities` transition table, which
-- does not exist in a row-level context.
DROP TRIGGER IF EXISTS activities_sync_last_activity ON activities;
CREATE OR REPLACE FUNCTION sync_last_activity() RETURNS trigger AS $$
BEGIN
  UPDATE contacts c
     SET last_activity_at = agg.newest
    FROM (
      SELECT contact_id, max(occurred_at) AS newest
        FROM new_activities
       GROUP BY contact_id
    ) AS agg
   WHERE c.id = agg.contact_id
     AND (c.last_activity_at IS NULL OR c.last_activity_at < agg.newest);
  RETURN NULL; -- statement-level AFTER trigger: the return value is ignored
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER activities_sync_last_activity AFTER INSERT ON activities
  REFERENCING NEW TABLE AS new_activities
  FOR EACH STATEMENT EXECUTE FUNCTION sync_last_activity();

GRANT SELECT, INSERT, UPDATE, DELETE ON activities TO leadwolf_app;
