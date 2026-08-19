-- accountScores.sql — RLS + the fit-sync trigger for account-grain scoring (0129, MI-S4). Workspace
-- isolation NULLIF fail-closed like intel.sql; the trigger keeps accounts.icp_fit_score a CACHE of the
-- latest FIT (name-honest — never the composite), the scores_sync_priority precedent. Idempotent.

ALTER TABLE account_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_scores FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_scores_workspace_isolation ON account_scores;
CREATE POLICY account_scores_workspace_isolation ON account_scores
  USING (workspace_id = (SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (workspace_id = (SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid));

CREATE OR REPLACE FUNCTION sync_account_icp_fit() RETURNS trigger AS $$
BEGIN
  UPDATE accounts SET icp_fit_score = NEW.icp_fit WHERE id = NEW.account_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS account_scores_sync_fit ON account_scores;
CREATE TRIGGER account_scores_sync_fit AFTER INSERT ON account_scores
  FOR EACH ROW EXECUTE FUNCTION sync_account_icp_fit();

GRANT SELECT, INSERT ON account_scores TO leadwolf_app;
