-- 0076_forge_review_task_idempotency.sql — make the verify stage idempotent (P-01.16). The verify processor
-- runs on an at-least-once queue and did a plain INSERT, so a redelivered/retried job DUPLICATED the human
-- review task. A PARTIAL unique index enforces at-most-one OPEN task per (subject_ref, task_type): a redelivery
-- converges via ON CONFLICT DO NOTHING, while a NEW task is still allowed once the prior one is resolved
-- (mirrors the one-active-version pattern). HAND-AUTHORED (drizzle-kit generate is forbidden).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_review_tasks_one_open
  ON forge.review_tasks (subject_ref, task_type) WHERE status = 'open';

-- DOWN (manual):
--   DROP INDEX IF EXISTS forge.uniq_review_tasks_one_open;
