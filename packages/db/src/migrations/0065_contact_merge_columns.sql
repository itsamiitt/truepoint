-- 0065_contact_merge_columns.sql — S-C1 (import-and-data-model-redesign 04 §1/§3; 15 §M-SEQ seq 60).
-- ADDITIVE DDL ONLY — the irreversible merge-supersession pointer + its commit timestamp on the contacts
-- overlay row. DISTINCT from the reversible `duplicate_of_contact_id` suggestion marker (04 §1 "Why a new
-- pointer"): `merged_into_contact_id` is set once, on the LOSER, at merge commit and never cleared (merge is
-- irreversible; there is no unmerge verb — 04 §3.6). Nothing writes these columns until the S-C4 engine
-- lands AND the S-C3 dual gate (CONTACT_MERGE_ENABLED env + `contact_merge_enabled` flag) evaluates ON, so
-- this migration is behaviour-neutral: every read/write path is byte-identical until then (§R-P4 — the
-- columns are additive/nullable, so DOWN = drop them, safe while flag-off wrote nothing).
--
-- Self-FK ON DELETE SET NULL mirrors `duplicate_of_contact_id` (contacts.ts): the survivor is a LIVE row, but
-- were it ever hard-purged (retention/DSAR) the dangling pointer nulls rather than blocking the purge — the
-- loser tombstone's soft-delete keeps Class-B ledger FKs valid regardless (04 §3.4).

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS merged_into_contact_id uuid,
  ADD COLUMN IF NOT EXISTS merged_at timestamptz;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contacts_merged_into_contact_id_fk'
  ) THEN
    ALTER TABLE contacts
      ADD CONSTRAINT contacts_merged_into_contact_id_fk
      FOREIGN KEY (merged_into_contact_id) REFERENCES contacts(id) ON DELETE SET NULL;
  END IF;
END $$;
--> statement-breakpoint

-- Partial index on the tombstoned-loser set only (04 §1): tiny (merged rows are a fraction of the table),
-- serves the "resolve a merged id → survivor" traversal (the 410-style detail read) + the merge-audit metrics.
CREATE INDEX IF NOT EXISTS idx_contacts_merged_into
  ON contacts (merged_into_contact_id)
  WHERE merged_into_contact_id IS NOT NULL;

-- DOWN (manual, per 15 §R-P4 — safe while the merge gate is off / nothing written):
--   DROP INDEX IF EXISTS idx_contacts_merged_into;
--   ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_merged_into_contact_id_fk;
--   ALTER TABLE contacts DROP COLUMN IF EXISTS merged_at, DROP COLUMN IF EXISTS merged_into_contact_id;
