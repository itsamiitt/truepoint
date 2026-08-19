-- 0131_reverify_indexes.sql — index the freshness re-verification read paths [S-09][S-13]
-- (hand-authored — expression + partial indexes are not expressible through the schema DSL without drift,
-- and drizzle-kit generate is forbidden here; perf-audit P1.6).
--
-- Two re-verification reads scanned every revealed contact:
--  1. contactRepository.findStaleRevealedForReverify — the per-batch keyset read: WHERE is_revealed AND
--     deleted_at IS NULL AND (last_verified_at IS NULL OR < cutoff), ORDER BY
--     coalesce(last_verified_at, created_at), id. The sort is an EXPRESSION with no matching index, so every
--     page of every run re-sorted the workspace's whole revealed set under the RLS predicate.
--  2. contactRepository.listWorkspacesWithStaleRevealed — the daily sweep's fleet-wide
--     SELECT DISTINCT tenant_id, workspace_id (owner connection): a full scan of every revealed contact in
--     the fleet per tick (LIMIT cannot short-circuit the aggregate).
--
-- Both indexes are PARTIAL on the revealed, live set — exactly the rows these reads touch, and a small
-- fraction of the table. The coalesce expression MUST stay in step with the repository's
-- coalesce(last_verified_at, created_at): an expression index is only consulted when the parsed expressions
-- match (the 0081 idx_contacts_trgm_full_name precedent).
--
-- CONCURRENTLY + one statement per breakpoint + IF NOT EXISTS: the 0081 posture (no ACCESS EXCLUSIVE lock on
-- the hottest table; re-runnable; a failed CONCURRENTLY build leaves an INVALID index the planner ignores —
-- drop it by name and re-run).

SET statement_timeout = 0;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_ws_reverify_due
  ON contacts (workspace_id, (coalesce(last_verified_at, created_at)), id)
  WHERE is_revealed = true AND deleted_at IS NULL;
--> statement-breakpoint
-- last_verified_at rides as a stored key column so the sweep's staleness filter is answered from the index
-- (index-only scan over the small partial set instead of a heap scan of the fleet).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_reverify_sweep
  ON contacts (tenant_id, workspace_id, last_verified_at)
  WHERE is_revealed = true AND deleted_at IS NULL;
