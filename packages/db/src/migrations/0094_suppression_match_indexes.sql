-- 0094_suppression_match_indexes.sql — index the suppression_list MATCH columns (08-architecture invariant 3;
-- 09 § Data-subject rights; outcome S-11). Pure expand: three partial indexes, no behaviour change.
--
-- WHY NOW, WHEN THE SEARCH FILTER IS NOT BUILT YET
-- suppression_list carries CHECK constraints and no index on any of the three columns every matcher keys off.
-- Today that is survivable because the matchers run ONE subject at a time inside a reveal/send transaction —
-- a sequential scan of a small table, once per action. It stops being survivable the moment suppression is
-- enforced at search, which is the busiest read in the product: an anti-join over three OR'd predicates with
-- no index on any of them would be paid on every keystroke of every user.
--
-- These indexes are correct and useful for the matchers that already ship (findMatch, findMatchExplicit, and
-- the new set-based suppressedContactIds behind the CSV export), so they are worth having on their own. They
-- also mean the eventual search predicate can be measured against a realistic plan rather than against a table
-- that was never indexed — measuring the wrong thing is how a "too slow" verdict gets recorded for a design
-- that was only ever un-indexed.
--
-- PARTIAL, because each row populates exactly one match key (the suppression_match_key_present CHECK enforces
-- that): indexing the NULLs would triple the size for rows that can never match on that column.

CREATE INDEX IF NOT EXISTS idx_suppression_email_blind_index
  ON suppression_list (email_blind_index)
  WHERE email_blind_index IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_suppression_domain
  ON suppression_list (domain)
  WHERE domain IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_suppression_contact
  ON suppression_list (contact_id)
  WHERE contact_id IS NOT NULL;
--> statement-breakpoint
-- The phone rung has no matcher yet (SuppressionKeys carries no phone), but the column exists and the DNC
-- programme in Phase 6 is exactly a phone programme. Indexed now so that work does not start by discovering
-- the same gap.
CREATE INDEX IF NOT EXISTS idx_suppression_phone_blind_index
  ON suppression_list (phone_blind_index)
  WHERE phone_blind_index IS NOT NULL;

-- DOWN (manual — indexes only, safe at any time):
--   DROP INDEX IF EXISTS idx_suppression_email_blind_index, idx_suppression_domain,
--                        idx_suppression_contact, idx_suppression_phone_blind_index;
