-- workerOutbox.sql — RLS for the transactional outbox (ADR-0027; worker-platform Phase 3). Workspace-scoped
-- like enrichment_jobs: the ONLY app-role writer is the confirm transition inside withTenantTx, so the policy
-- pins the workspace GUC on INSERT (WITH CHECK) and on any read.
--
-- ENABLE (not FORCE) — deliberately, mirroring notifications/purchases/audit_log: the RELAY drains/settles
-- rows on the SYSTEM path (the table-OWNER connection with NO workspace GUC — apps/workers/src/outboxRelay.ts),
-- and a FORCE policy would BLOCK the owner (the owner is subject to FORCE but bypasses ENABLE). The customer
-- app role (leadwolf_app) is non-owner, so ENABLE still isolates it fully. leadwolf_app gets INSERT only
-- (least privilege): it never reads, updates, or deletes outbox rows — publish/settle is exclusively the
-- relay's job. NULLIF idiom → an unset/reset GUC fails closed. Idempotent — safe to re-run every migrate.

ALTER TABLE worker_outbox ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS worker_outbox_workspace_isolation ON worker_outbox;
CREATE POLICY worker_outbox_workspace_isolation ON worker_outbox
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

GRANT INSERT ON worker_outbox TO leadwolf_app;
