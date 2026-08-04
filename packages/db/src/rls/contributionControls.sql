-- contributionControls.sql — access model for the three Phase 4 contribution-control tables.
--
-- ACCESS MODEL: full read/write for the customer app role, workspace-scoped. This is the OPPOSITE of the
-- entitlement posture next door, and the asymmetry is the point. An entitlement is a cap the platform imposes,
-- so a role that could grant itself one has no cap at all. A contribution control is a restriction the CUSTOMER
-- imposes on US — self-service is the entire feature. 09-compliance rule 5 requires consent to be revocable,
-- and a revocation that needs a support ticket is not revocable in any sense a regulator recognises.
--
-- The dangerous direction is only ever the permissive one: adding an exclusion or turning contribution OFF can
-- be done by anyone in the workspace without harm. Turning it ON is a consent act, gated two ways — the
-- contribution_policy_enabled_is_attributed CHECK forces an actor and a timestamp onto the row, and the API
-- layer requires an admin role. Neither belongs in RLS, which cannot see who is asking beyond the tenancy GUCs.
--
-- WORKSPACE-scoped, not tenant-scoped, unlike entitlement: two workspaces in one tenant can hold genuinely
-- different data (an agency running separate client books is the ordinary case) and must be able to make
-- genuinely different sharing choices. A tenant-wide switch would force the most cautious workspace's answer
-- on everyone or, far worse, the least cautious one.
--
-- The reader that matters — the master-backfill contribution gate — runs per workspace under withTenantTx, so
-- these policies are its isolation. There is no privileged bypass path: a backfill that could read another
-- workspace's exclusions could also ignore its own.

ALTER TABLE contribution_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE contribution_policy FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contribution_policy_workspace ON contribution_policy;
CREATE POLICY contribution_policy_workspace ON contribution_policy FOR ALL
  USING (workspace_id = (SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (
    workspace_id = (SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
    AND tenant_id = (SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  );

ALTER TABLE contribution_exclusion ENABLE ROW LEVEL SECURITY;
ALTER TABLE contribution_exclusion FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contribution_exclusion_workspace ON contribution_exclusion;
CREATE POLICY contribution_exclusion_workspace ON contribution_exclusion FOR ALL
  USING (workspace_id = (SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (
    workspace_id = (SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
    AND tenant_id = (SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  );

ALTER TABLE crm_object_contribution ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_object_contribution FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_object_contribution_workspace ON crm_object_contribution;
CREATE POLICY crm_object_contribution_workspace ON crm_object_contribution FOR ALL
  USING (workspace_id = (SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (
    workspace_id = (SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
    AND tenant_id = (SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  );

-- Documentary; the wall above is FORCE RLS plus these policies. applyMigrations' final phase grants
-- leadwolf_app every table privilege anyway, so a REVOKE here would simply be undone.
GRANT SELECT, INSERT, UPDATE, DELETE ON contribution_policy TO leadwolf_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON contribution_exclusion TO leadwolf_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_object_contribution TO leadwolf_app;
