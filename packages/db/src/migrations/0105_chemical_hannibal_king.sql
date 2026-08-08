-- 0105_chemical_hannibal_king.sql — audit D9: let an employment assertion exist before its employer resolves.
--
-- THIS IS THE ONLY CHANGE TO AN EXISTING COLUMN IN THE WHOLE intelligence-platform PROGRAM. Everything else
-- (0100–0104) is new tables. It gets its own migration and its own itest for exactly that reason.
--
-- WHAT WAS WRONG
-- master_employment.master_company_id was NOT NULL. An assertion like "Jane Doe, VP Finance at Contoso Ltd"
-- whose employer ER had not yet matched to a master_companies row could not be recorded AT ALL — the insert
-- was rejected and the assertion was LOST, along with the title, dates and provenance that came with it.
--
-- THE FIX (cascade 1.md §2.3's one genuinely better structural idea, adopted)
-- Keep the raw employer name BESIDE the resolved id. The assertion survives until ER catches up, and can be
-- re-resolved later without re-fetching the source. company_name_normalized is written by the SAME code path
-- that computes master_companies.name_normalized — deliberately a stored column rather than an expression
-- index over a SQL normalization function, because two implementations of "normalize a company name" (one in
-- TypeScript, one in plpgsql) will drift, and the day they do, unresolved stints silently stop deduping
-- against the key master_companies actually uses.
--
-- WHY THIS IS NON-DESTRUCTIVE
--   1. DROP NOT NULL only WEAKENS a constraint. Every existing row already satisfies the weaker form; no row
--      can be invalidated and none is rewritten.
--   2. Both ADD COLUMNs are nullable with no default — metadata-only in PG 11+, no table rewrite.
--   3. Both new indexes are PARTIAL on `master_company_id IS NULL`, which matches ZERO existing rows today,
--      so the build is trivial regardless of table size.
--   4. The CHECK is added NOT VALID and validated separately — see below.
--
-- WHY THE CHECK IS SPLIT INTO NOT VALID + VALIDATE
-- A plain `ADD CONSTRAINT ... CHECK` takes an ACCESS EXCLUSIVE lock and full-scans the table to verify it,
-- blocking reads and writes for the duration. Every existing row passes (they all have a non-null
-- master_company_id), so the verdict is never in doubt — but on a table sized for the graph the SCAN is the
-- problem, not the result. ADD ... NOT VALID takes the lock only briefly and enforces the constraint on all
-- NEW rows immediately; VALIDATE CONSTRAINT then does the scan under SHARE UPDATE EXCLUSIVE, which does not
-- block readers or writers. Same end state, no write outage. (Migration 0084 makes the same point about
-- validating constraints on very large tables.)

ALTER TABLE "master_employment" ALTER COLUMN "master_company_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "master_employment" ADD COLUMN "company_name_raw" varchar(255);--> statement-breakpoint
ALTER TABLE "master_employment" ADD COLUMN "company_name_normalized" "citext";--> statement-breakpoint

-- Dedup for the UNRESOLVED case. uniq_employment_stint cannot cover it any more: master_company_id is now
-- nullable and Postgres treats NULLs as DISTINCT in a unique index, so without this every re-ingest of the
-- same unresolved assertion would mint another row.
--
-- BEST-EFFORT, NOT EXACT — callers must not assume otherwise. started_on defaults to the '-infinity'
-- "unknown start" sentinel, so two genuinely different employers sharing a normalized name AND an unknown
-- start will collide into one edge until ER resolves them. That is the better failure than unbounded
-- duplicate stints, and it is reversible: source_records and match_links keep the evidence to split them.
CREATE UNIQUE INDEX "uniq_employment_unresolved_stint" ON "master_employment" USING btree ("master_person_id","company_name_normalized","started_on") WHERE "master_employment"."master_company_id" IS NULL AND "master_employment"."company_name_normalized" IS NOT NULL;--> statement-breakpoint

-- The ER work queue: unresolved stints waiting for a company match.
CREATE INDEX "idx_employment_unresolved" ON "master_employment" USING btree ("company_name_normalized") WHERE "master_employment"."master_company_id" IS NULL;--> statement-breakpoint

-- A stint must identify its employer SOMEHOW. Without this, dropping the NOT NULL would admit a completely
-- employerless row — which is worse than the rejection this migration exists to remove.
ALTER TABLE "master_employment" ADD CONSTRAINT "master_employment_employer_present" CHECK ("master_employment"."master_company_id" IS NOT NULL OR "master_employment"."company_name_raw" IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "master_employment" VALIDATE CONSTRAINT "master_employment_employer_present";

-- DOWN (manual):
--   ALTER TABLE master_employment DROP CONSTRAINT master_employment_employer_present;
--   DROP INDEX idx_employment_unresolved; DROP INDEX uniq_employment_unresolved_stint;
--   ALTER TABLE master_employment DROP COLUMN company_name_normalized, DROP COLUMN company_name_raw;
--   -- Restoring the NOT NULL is only safe once every unresolved row has been resolved or removed; it is a
--   -- STRENGTHENING and will fail outright if any master_company_id IS NULL. That asymmetry is the point:
--   -- this migration is safe to apply and deliberately awkward to undo once unresolved rows exist.
