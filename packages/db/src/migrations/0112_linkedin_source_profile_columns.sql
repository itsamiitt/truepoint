-- 0112_linkedin_source_profile_columns.sql — Layer-0 profile columns for the linkedin_api source
-- [S-09][S-13][S-10][A-01] (hand-authored, additive-only; the rollback lever is the flag, never a DROP).
--
-- Closes the structured-storage gaps the `source plan/` sample payloads exposed:
--   1) master_companies — firmographic profile facts (description/website/ownership/year/specialties/media)
--      as COLUMNS (a jsonb blob would repeat the technographics mistake dropped in 0108), plus a STRUCTURED
--      revenue band (min/max minor units + currency) beside the display varchar, which stays and is
--      dual-written ("$5M–$10M").
--   2) master_persons — headline/summary/location_raw: professional self-description, the same
--      business-contact class as job_title (09-compliance rule 3). The sensitive-adjacent payload fields
--      (pronoun, premium, open_link, job_seeker, photo URLs) get NO columns — raw-only in
--      source_records.raw_data behind a HUMAN GATE (docs/planning/linkedin-source-ingestion/).
--   3) master_employment — per-stint location/description + partial-date precision. Sources assert
--      "2018" or "2018-03"; dates stay real `date`s (the '-infinity' sentinel and stint uniques are
--      load-bearing), precision records what was actually asserted.
--   4) master_education — the same two precision columns (bare years are the norm there).
--
-- No new tables, no new grants: every column lands on an existing master_* table already covered by the
-- ^master_ REVOKE convention loop in applyMigrations.ts.

ALTER TABLE "master_companies" ADD COLUMN IF NOT EXISTS "description" text;
--> statement-breakpoint
ALTER TABLE "master_companies" ADD COLUMN IF NOT EXISTS "website_url" varchar(500);
--> statement-breakpoint
ALTER TABLE "master_companies" ADD COLUMN IF NOT EXISTS "ownership_type" varchar(30);
--> statement-breakpoint
ALTER TABLE "master_companies" ADD COLUMN IF NOT EXISTS "year_founded" integer;
--> statement-breakpoint
ALTER TABLE "master_companies" ADD COLUMN IF NOT EXISTS "specialties" text[];
--> statement-breakpoint
ALTER TABLE "master_companies" ADD COLUMN IF NOT EXISTS "logo_url" text;
--> statement-breakpoint
ALTER TABLE "master_companies" ADD COLUMN IF NOT EXISTS "background_image_url" text;
--> statement-breakpoint
ALTER TABLE "master_companies" ADD COLUMN IF NOT EXISTS "revenue_min_minor" bigint;
--> statement-breakpoint
ALTER TABLE "master_companies" ADD COLUMN IF NOT EXISTS "revenue_max_minor" bigint;
--> statement-breakpoint
ALTER TABLE "master_companies" ADD COLUMN IF NOT EXISTS "revenue_currency" char(3);
--> statement-breakpoint
ALTER TABLE "master_companies" DROP CONSTRAINT IF EXISTS "master_companies_ownership_type_enum";
--> statement-breakpoint
ALTER TABLE "master_companies" ADD CONSTRAINT "master_companies_ownership_type_enum"
  CHECK ("ownership_type" IS NULL OR "ownership_type" IN
    ('public','private','nonprofit','government','partnership','sole_proprietorship','self_employed','educational','other'));
--> statement-breakpoint
ALTER TABLE "master_companies" DROP CONSTRAINT IF EXISTS "master_companies_year_founded_range";
--> statement-breakpoint
ALTER TABLE "master_companies" ADD CONSTRAINT "master_companies_year_founded_range"
  CHECK ("year_founded" IS NULL OR "year_founded" BETWEEN 1000 AND 2100);
--> statement-breakpoint
ALTER TABLE "master_companies" DROP CONSTRAINT IF EXISTS "master_companies_revenue_needs_currency";
--> statement-breakpoint
ALTER TABLE "master_companies" ADD CONSTRAINT "master_companies_revenue_needs_currency"
  CHECK (("revenue_min_minor" IS NULL AND "revenue_max_minor" IS NULL) OR "revenue_currency" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "master_companies" DROP CONSTRAINT IF EXISTS "master_companies_revenue_min_le_max";
--> statement-breakpoint
ALTER TABLE "master_companies" ADD CONSTRAINT "master_companies_revenue_min_le_max"
  CHECK ("revenue_min_minor" IS NULL OR "revenue_max_minor" IS NULL OR "revenue_min_minor" <= "revenue_max_minor");
--> statement-breakpoint
ALTER TABLE "master_persons" ADD COLUMN IF NOT EXISTS "headline" varchar(255);
--> statement-breakpoint
ALTER TABLE "master_persons" ADD COLUMN IF NOT EXISTS "summary" text;
--> statement-breakpoint
ALTER TABLE "master_persons" ADD COLUMN IF NOT EXISTS "location_raw" varchar(255);
--> statement-breakpoint
ALTER TABLE "master_employment" ADD COLUMN IF NOT EXISTS "location" varchar(255);
--> statement-breakpoint
ALTER TABLE "master_employment" ADD COLUMN IF NOT EXISTS "description" text;
--> statement-breakpoint
ALTER TABLE "master_employment" ADD COLUMN IF NOT EXISTS "start_precision" varchar(5);
--> statement-breakpoint
ALTER TABLE "master_employment" ADD COLUMN IF NOT EXISTS "end_precision" varchar(5);
--> statement-breakpoint
ALTER TABLE "master_employment" DROP CONSTRAINT IF EXISTS "master_employment_start_precision_enum";
--> statement-breakpoint
ALTER TABLE "master_employment" ADD CONSTRAINT "master_employment_start_precision_enum"
  CHECK ("start_precision" IS NULL OR "start_precision" IN ('year','month','day'));
--> statement-breakpoint
ALTER TABLE "master_employment" DROP CONSTRAINT IF EXISTS "master_employment_end_precision_enum";
--> statement-breakpoint
ALTER TABLE "master_employment" ADD CONSTRAINT "master_employment_end_precision_enum"
  CHECK ("end_precision" IS NULL OR "end_precision" IN ('year','month','day'));
--> statement-breakpoint
ALTER TABLE "master_education" ADD COLUMN IF NOT EXISTS "start_precision" varchar(5);
--> statement-breakpoint
ALTER TABLE "master_education" ADD COLUMN IF NOT EXISTS "end_precision" varchar(5);
--> statement-breakpoint
ALTER TABLE "master_education" DROP CONSTRAINT IF EXISTS "master_education_start_precision_enum";
--> statement-breakpoint
ALTER TABLE "master_education" ADD CONSTRAINT "master_education_start_precision_enum"
  CHECK ("start_precision" IS NULL OR "start_precision" IN ('year','month','day'));
--> statement-breakpoint
ALTER TABLE "master_education" DROP CONSTRAINT IF EXISTS "master_education_end_precision_enum";
--> statement-breakpoint
ALTER TABLE "master_education" ADD CONSTRAINT "master_education_end_precision_enum"
  CHECK ("end_precision" IS NULL OR "end_precision" IN ('year','month','day'));
