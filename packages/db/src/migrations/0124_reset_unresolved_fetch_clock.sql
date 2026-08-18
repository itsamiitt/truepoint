-- 0124_reset_unresolved_fetch_clock.sql — release the URLs a broken parser froze [S-09][A-01]
--
-- The vendor answers 200 with an ENVELOPE ({success, data, meta}); the client parsed the whole body as the
-- document, so every payload failed both contracts, landed NOTHING, and was still stamped `ok` on the
-- registry — burning the 30-day freshness clock on each URL. The client now unwraps the envelope and a
-- shape_drift is recorded as `rejected` rather than `ok`, but the already-stamped rows would sit unfetched
-- for a month with nothing stored.
--
-- This clears the clock for exactly those rows: fetched, reported `ok`, yet resolved NEITHER a person nor a
-- company — the signature of the bug, and a state a healthy landing never produces (a landed document always
-- stamps at least one resolved id). Idempotent: after the fix these rows resolve and stop matching.
-- fetch_count is deliberately preserved — the attempts really happened; only the freshness clock is reset.

UPDATE "source_fetch_registry"
   SET "last_fetched_at" = NULL, "last_outcome" = NULL, "updated_at" = now()
 WHERE "last_fetched_at" IS NOT NULL
   AND "last_outcome" = 'ok'
   AND "resolved_person_id" IS NULL
   AND "resolved_company_id" IS NULL;

-- DOWN: none. Re-fetching a URL is free (the 30-day rule reapplies from the next attempt).
