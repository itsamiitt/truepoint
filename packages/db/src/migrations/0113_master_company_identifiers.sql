-- 0113_master_company_identifiers.sql — company external-id table for the linkedin_api source
-- [S-09][S-13][A-01] (hand-authored, additive-only).
--
-- The COMPANY twin of master_person_identifiers (0104 / audit D8): one row per (type, value) instead of one
-- COLUMN per source. Positions in the source payload are keyed by a numeric LinkedIn company_id with NO
-- domain, so resolvable company identifiers are what keeps every position employer from being permanently
-- unresolved. `master_companies.linkedin_company_id` STAYS (hot, partial-unique since 0017) and is
-- dual-written; the backfill below makes the two agree, byte-for-byte the 0104 person pattern.
--
-- Naming: master_* → the ^master_ convention loop in applyMigrations.ts auto-REVOKEs leadwolf_app; the
-- explicit REVOKE/GRANT lists there gain this table in the same PR (the 0108 lesson — 42501 only caught
-- by CI when the GRANT edit is forgotten).

CREATE TABLE IF NOT EXISTS "master_company_identifiers" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "master_company_id" uuid NOT NULL REFERENCES "master_companies"("id") ON DELETE CASCADE,
  "id_type" varchar(40) NOT NULL,
  "id_value" citext NOT NULL,
  "source_name" varchar(50),
  "observed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_master_company_identifier"
  ON "master_company_identifiers" ("id_type", "id_value");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_master_company_identifier_company"
  ON "master_company_identifiers" ("master_company_id");
--> statement-breakpoint
-- Backfill: every company that already carries the LinkedIn id column gets an identifier row, so column
-- and table agree from day one (0104 precedent). ON CONFLICT DO NOTHING → re-runnable.
INSERT INTO "master_company_identifiers" ("master_company_id", "id_type", "id_value", "source_name", "observed_at")
SELECT "id", 'linkedin_company_id', "linkedin_company_id", 'backfill_0113', "created_at"
FROM "master_companies"
WHERE "linkedin_company_id" IS NOT NULL
ON CONFLICT ("id_type", "id_value") DO NOTHING;
