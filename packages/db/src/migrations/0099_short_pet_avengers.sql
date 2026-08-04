-- 0099_short_pet_avengers.sql — the ≤72h deadline on a data-subject request (06-roadmap Phase 5 "DSAR
-- workflow automation … SLA-tracked"; 09-compliance "automated SLA ≤72h (A-02)").
--
-- The AC is a TIME, and nothing in the schema could express one. `requested_at` was the only clock and no
-- query read it as a deadline, so a request could sit in `received` indefinitely and no surface would say so.
-- A missed SLA that nobody can see is indistinguishable from no SLA.
--
-- DRIZZLE-GENERATED, deliberately. dsar_requests IS in the drizzle barrel, so hand-authoring this would have
-- added one more missing link to the snapshot chain migrationSnapshots.test.ts exists to ratchet — the exact
-- debt 0091 and 0094 are still carrying. The generated form is byte-for-byte what the hand-written one said.
--
-- The DEFAULT is 72 hours from now rather than from requested_at, because a column default cannot reference
-- another column of the same row. They are the same instant for any row inserted normally (requested_at also
-- defaults to now()), and every reader coalesces to `requested_at + interval '72 hours'` anyway, so a row
-- that predates this column still answers the question correctly.
--
-- NOT NULL is deliberately absent: stamping existing rows with "72 hours from the migration" would invent an
-- SLA that was never promised and make historical breaches disappear. They keep NULL and the coalesce derives
-- their real deadline from when they actually arrived.
--
-- The index is PARTIAL because a completed or rejected request can never breach, and those will eventually be
-- the overwhelming majority of the table. It serves dsarRequestRepository.findOverdue — a deadline column
-- nothing queries is a comment with a type.

ALTER TABLE "dsar_requests" ADD COLUMN "due_at" timestamp with time zone DEFAULT now() + interval '72 hours';--> statement-breakpoint
CREATE INDEX "idx_dsar_requests_due" ON "dsar_requests" USING btree ("due_at") WHERE "dsar_requests"."status" NOT IN ('completed', 'rejected');

-- DOWN (manual):
--   DROP INDEX idx_dsar_requests_due;
--   ALTER TABLE dsar_requests DROP COLUMN due_at;
