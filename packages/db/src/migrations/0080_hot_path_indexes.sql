-- 0080_hot_path_indexes — indexes for read paths that were doing top-N sorts with no usable index.
--
-- Each of these backs a query shape that exists in the repositories today; the ORDER BY / predicate was matched
-- against the source, because an index that does not match the sort expression exactly is dead weight:
--
--   1. contacts (workspace_id, created_at DESC, id DESC) WHERE deleted_at IS NULL
--      searchRepository's DEFAULT sort — `ORDER BY contacts.created_at DESC, contacts.id DESC` — i.e. the
--      ordering behind every unsorted search, the contact list, and resolveVisibleIds. `accounts` already had
--      its equivalent (idx_accounts_ws_created_at); contacts never did, so the busiest read in the product was
--      a top-N heapsort over the whole RLS-visible workspace slice on every page. Partial on deleted_at because
--      the list paths exclude soft-deleted rows.
--
--   2. contacts (workspace_id, coalesce(priority_score, -1) DESC, id DESC)
--      The score sort is `ORDER BY coalesce(contacts.priority_score, -1) DESC, contacts.id DESC`, and its
--      keyset seek compares the same coalesce tuple. idx_contacts_ws_priority_score indexes the BARE column,
--      which cannot serve a coalesce() expression — so this needs an expression index to be usable at all.
--
--   3. activities (workspace_id, occurred_at DESC, activity_type)
--      countByTypeForWorkspace filters `occurred_at >= $since` and groups by activity_type (RLS supplies the
--      workspace predicate). The only existing index is (workspace_id, contact_id, occurred_at DESC): with
--      contact_id in the middle, the occurred_at range cannot be used, so the Home summary read every activity
--      row in the workspace. activity_type trails so the aggregate can be satisfied from the index.
--
--   4. list_members (list_id, added_at DESC, id DESC) and (contact_id)
--      The member page sorts `ORDER BY added_at DESC, id DESC`; only (list_id, contact_id) existed. The
--      (contact_id) index serves the reverse lookup ("which lists hold this contact") and the FK direction,
--      which had no index at all.
--
-- CONCURRENTLY, and each build ALONE between statement-breakpoints: applyJournalByHash sends each chunk as its
-- own autocommit statement (there is no BEGIN), which is what makes CONCURRENTLY legal here — but a chunk
-- holding several statements would be wrapped in one implicit transaction and fail with 25001. Do not merge
-- these lines. IF NOT EXISTS keeps a resumed run idempotent (the hash row is written last, so an aborted run
-- replays the whole file).
--
-- statement_timeout is lifted for this migration because the migrator connection sets 120s, which is not enough
-- to build these on a large contacts/activities table; it is restored at the end. A CONCURRENTLY build that is
-- cancelled leaves an INVALID index behind, and 25001/57014 are not in the tolerated-SQLSTATE list, so the run
-- would abort rather than silently continue.
SET statement_timeout = 0;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_ws_created_at
  ON contacts (workspace_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_ws_priority_score_coalesced
  ON contacts (workspace_id, (coalesce(priority_score, -1)) DESC, id DESC)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activities_ws_occurred_type
  ON activities (workspace_id, occurred_at DESC, activity_type);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_list_members_list_added_at
  ON list_members (list_id, added_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_list_members_contact
  ON list_members (contact_id);
--> statement-breakpoint
SET statement_timeout = '120s';
