-- 0095_rebaseline_chain.sql — REBASELINE, not new schema. Emitted by `drizzle-kit generate` and then made
-- idempotent by hand.
--
-- WHAT THIS IS. The drizzle snapshot chain has a long-standing gap (P-1.7): hand-authored migrations do not
-- carry snapshots, so `generate` diffs the schema barrel against the newest snapshot it HAS rather than
-- against reality. Running it after 0088-0094 therefore re-emitted the two barrel-visible changes from that
-- run — 0091's policy `lawful_basis` columns and 0094's suppression_list indexes — because no snapshot
-- recorded them. The DDL below is those, and ONLY those, which is itself the useful result: it proves the
-- barrel has no OTHER drift from what the hand-written migrations already applied.
--
-- The valuable artifact of this file is not its SQL — it is 0095_snapshot.json, which now describes the full
-- current schema so the NEXT `generate` diffs correctly. That is exactly how 0083 rebaselined the chain
-- before; this repeats it after the Phase 1 spine.
--
-- WHY EVERY STATEMENT IS GUARDED. As generated, none of these were idempotent, and on any database that had
-- already run 0091/0094 they would each raise "already exists". applyMigrations TOLERATES those specific codes
-- (42701 duplicate_column, 42P07 duplicate_table, 42710 duplicate_object), so it would have converged anyway —
-- but by printing a "tolerated" line for every statement on every deploy. Guards that are load-bearing and
-- guards that are noise look identical in a log, and training people to skim past "tolerated" is how a real
-- half-applied migration gets missed later. So these say what they mean instead.
--
-- The snapshot deficit is UNCHANGED by this file (one journal entry, one snapshot). 0091 and 0094 still have
-- no snapshots of their own and the historical gap is still the thing P-1.7 exists to repair — what changes is
-- that the chain is usable going forward.

ALTER TABLE enrichment_policy ADD COLUMN IF NOT EXISTS lawful_basis varchar(30);
--> statement-breakpoint
ALTER TABLE import_policy ADD COLUMN IF NOT EXISTS lawful_basis varchar(30);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_suppression_email_blind_index
  ON suppression_list USING btree (email_blind_index) WHERE email_blind_index IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_suppression_domain
  ON suppression_list USING btree (domain) WHERE domain IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_suppression_contact
  ON suppression_list USING btree (contact_id) WHERE contact_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_suppression_phone_blind_index
  ON suppression_list USING btree (phone_blind_index) WHERE phone_blind_index IS NOT NULL;
--> statement-breakpoint
-- ADD CONSTRAINT has no IF NOT EXISTS in Postgres, so DROP-then-ADD is the idempotent form. Safe because the
-- constraint is a pure CHECK: dropping and re-adding re-validates the same predicate over the same rows.
ALTER TABLE enrichment_policy DROP CONSTRAINT IF EXISTS enrichment_policy_lawful_basis_enum;
--> statement-breakpoint
ALTER TABLE enrichment_policy ADD CONSTRAINT enrichment_policy_lawful_basis_enum
  CHECK (lawful_basis IS NULL OR lawful_basis IN ('legitimate_interest','consent','contract','public_record'));
--> statement-breakpoint
ALTER TABLE import_policy DROP CONSTRAINT IF EXISTS import_policy_lawful_basis_enum;
--> statement-breakpoint
ALTER TABLE import_policy ADD CONSTRAINT import_policy_lawful_basis_enum
  CHECK (lawful_basis IS NULL OR lawful_basis IN ('legitimate_interest','consent','contract','public_record'));

-- DOWN (manual): this file adds nothing 0091/0094 did not already add — reverting those reverts this.
