-- intel.sql — RLS + the score-sync trigger for the intelligence layer (03 §6/§10, ADR-0008) and the
-- enrichment cost/cache table (03 §8). Workspace-scoped like contacts; policies use the NULLIF idiom so
-- unset/reset GUCs fail closed. Idempotent — safe to re-run on every migrate.

ALTER TABLE scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE scores FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scores_workspace_isolation ON scores;
CREATE POLICY scores_workspace_isolation ON scores
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

-- Score sync (03 §10): contacts.priority_score is a CACHE of the latest composite — kept by trigger so it
-- holds regardless of caller. The scores table itself stays append-only history.
CREATE OR REPLACE FUNCTION sync_priority_score() RETURNS trigger AS $$
BEGIN
  UPDATE contacts SET priority_score = NEW.composite_score WHERE id = NEW.contact_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS scores_sync_priority ON scores;
CREATE TRIGGER scores_sync_priority AFTER INSERT ON scores
  FOR EACH ROW EXECUTE FUNCTION sync_priority_score();

ALTER TABLE intent_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE intent_signals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS intent_signals_workspace_isolation ON intent_signals;
CREATE POLICY intent_signals_workspace_isolation ON intent_signals
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

ALTER TABLE provider_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_calls FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS provider_calls_workspace_isolation ON provider_calls;
CREATE POLICY provider_calls_workspace_isolation ON provider_calls
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON scores, intent_signals, provider_calls TO leadwolf_app;
