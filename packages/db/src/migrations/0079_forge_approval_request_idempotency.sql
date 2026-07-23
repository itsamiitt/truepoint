-- 0079_forge_approval_request_idempotency.sql — make the verify stage's approval-request creation idempotent
-- (P-01.10 producer). subject_ref is the gold candidate's content_hash; the partial unique keeps at-most-one
-- PENDING request per (op_class, subject_ref), so a redelivered verify job converges instead of piling up
-- duplicate approvals + review tasks. HAND-AUTHORED (drizzle-kit generate is forbidden). Safe while Forge is dark
-- (approval_requests holds no rows); leadwolf_forge is re-granted by the post-migration ALL-TABLES grant.
ALTER TABLE forge.approval_requests ADD COLUMN IF NOT EXISTS subject_ref text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_approval_requests_pending_subject
  ON forge.approval_requests (op_class, subject_ref) WHERE status = 'pending';

-- DOWN (manual — safe while Forge is dark):
--   DROP INDEX IF EXISTS forge.uniq_approval_requests_pending_subject;
--   ALTER TABLE forge.approval_requests DROP COLUMN IF EXISTS subject_ref;
