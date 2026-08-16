-- 0116_person_attributes_and_email_type.sql — Layer-0 multi-value person attributes + typed email kind
-- [S-04][S-08][A-01] (hand-authored, additive-only).
--
-- The C6 HUMAN GATE was opened by an explicit user instruction on 2026-08-16 ("make sure that there can be
-- multiple languages … skills etc"): master_person_skills + master_person_languages, one row per
-- (person, value), citext dedup, source_count corroboration — the master_person_identifiers posture.
-- Volunteering was NOT named and stays raw-only. master_emails gains email_type (the source's asserted
-- address KIND — distinct from email_status, the verification verdict) for the multi-email-with-type
-- landing the same instruction requested.
--
-- Hand-authored rather than drizzle-generated even though both tables are plain and in the barrel: the
-- snapshot chain HEAD is 0107, so `generate` proposes ALL drift since then and dies on an interactive
-- column-conflict prompt (per the 2026-08-04 correction in migrationSnapshots.test.ts, a retroactive
-- snapshot cannot be emitted either). The next rebaseline absorbs this link like 0091/0094/0111/0112.

CREATE TABLE IF NOT EXISTS "master_person_skills" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "master_person_id" uuid NOT NULL REFERENCES "master_persons"("id") ON DELETE CASCADE,
  "skill" citext NOT NULL,
  "source_name" varchar(50),
  "source_count" integer NOT NULL DEFAULT 1,
  "observed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_master_person_skill"
  ON "master_person_skills" ("master_person_id", "skill");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_master_person_skills_person"
  ON "master_person_skills" ("master_person_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_person_languages" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "master_person_id" uuid NOT NULL REFERENCES "master_persons"("id") ON DELETE CASCADE,
  "name" citext NOT NULL,
  "proficiency" varchar(30),
  "source_name" varchar(50),
  "source_count" integer NOT NULL DEFAULT 1,
  "observed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "master_person_languages_proficiency_enum" CHECK ("proficiency" IS NULL OR "proficiency" IN
    ('ELEMENTARY','LIMITED_WORKING','PROFESSIONAL_WORKING','FULL_PROFESSIONAL','NATIVE_OR_BILINGUAL'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_master_person_language"
  ON "master_person_languages" ("master_person_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_master_person_languages_person"
  ON "master_person_languages" ("master_person_id");
--> statement-breakpoint
ALTER TABLE "master_emails" ADD COLUMN IF NOT EXISTS "email_type" varchar(20);
--> statement-breakpoint
ALTER TABLE "master_emails" DROP CONSTRAINT IF EXISTS "master_emails_email_type_enum";
--> statement-breakpoint
ALTER TABLE "master_emails" ADD CONSTRAINT "master_emails_email_type_enum"
  CHECK ("email_type" IS NULL OR "email_type" IN ('work','personal','other'));

-- DOWN (manual — safe while LINKEDIN_CHANNELS_ENABLED is off):
--   DROP TABLE master_person_skills; DROP TABLE master_person_languages;
--   ALTER TABLE master_emails DROP COLUMN email_type;
