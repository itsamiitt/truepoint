-- notifications.sql — Row-Level Security for `notifications` (G-NTF-1). Workspace-scoped: the policy keys off
-- the transaction-LOCAL GUC app.current_workspace_id set by withTenantTx() under the NON-BYPASSRLS leadwolf_app
-- role. NULLIF(current_setting(..., true), '') treats an unset OR ''-reset GUC as no-scope, so an unscoped
-- query reads nothing (fail-closed). PER-USER visibility (a user sees only their OWN notifications) is enforced
-- in the repository by a user_id predicate — the GUC carries no user id; RLS guarantees the harder property:
-- workspace A can NEVER read workspace B's rows.
--
-- ENABLE (not FORCE) — deliberately, mirroring purchases/audit_log/tenants: the PRODUCERS write on the SYSTEM
-- path (the low-balance notifier + import-complete worker + provisionNewOrg welcome) on the table-OWNER
-- connection with NO workspace GUC, and a FORCE policy would BLOCK the owner (the owner is subject to FORCE but
-- bypasses ENABLE). The customer app role (leadwolf_app) is non-owner, so ENABLE still isolates every read +
-- the mark-read UPDATE to the caller's workspace. Idempotent (DROP POLICY IF EXISTS + CREATE).

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notifications_workspace_isolation ON notifications;
CREATE POLICY notifications_workspace_isolation ON notifications
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO leadwolf_app;
