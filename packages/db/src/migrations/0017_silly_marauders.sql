CREATE TABLE IF NOT EXISTS "master_companies" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"primary_domain" "citext",
	"alt_domains" "citext"[] DEFAULT '{}' NOT NULL,
	"name" varchar(255) NOT NULL,
	"name_normalized" "citext",
	"linkedin_company_id" varchar(255),
	"parent_company_id" uuid,
	"industry" varchar(100),
	"sub_industry" varchar(100),
	"employee_count" integer,
	"employee_band" varchar(20),
	"revenue_range" varchar(50),
	"technographics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hq_country" varchar(100),
	"hq_city" varchar(100),
	"data_quality_score" integer,
	"region" char(2),
	"jurisdiction" char(2),
	"block_key" varchar(255),
	"field_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prov_hwm" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_companies_data_quality_range" CHECK ("master_companies"."data_quality_score" IS NULL OR "master_companies"."data_quality_score" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_emails" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"master_person_id" uuid NOT NULL,
	"email_enc" "bytea" NOT NULL,
	"email_blind_index" "bytea" NOT NULL,
	"email_domain" "citext",
	"email_status" varchar(20) DEFAULT 'unverified' NOT NULL,
	"source_count" integer DEFAULT 1 NOT NULL,
	"last_verified_at" timestamp with time zone,
	"verification_source" varchar(50),
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_emails_email_status_enum" CHECK ("master_emails"."email_status" IN ('unverified','valid','risky','invalid','catch_all','unknown'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_employment" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"master_person_id" uuid NOT NULL,
	"master_company_id" uuid NOT NULL,
	"title" varchar(255),
	"department" varchar(100),
	"seniority_level" varchar(50),
	"is_current" boolean DEFAULT true NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"started_on" date DEFAULT '-infinity' NOT NULL,
	"ended_on" date,
	"asserting_source" varchar(50),
	"match_method" varchar(20),
	"confidence" numeric(4, 3),
	"source_count" integer DEFAULT 1 NOT NULL,
	"observed_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	"field_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prov_hwm" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_employment_seniority_enum" CHECK ("master_employment"."seniority_level" IS NULL OR "master_employment"."seniority_level" IN ('c_suite','vp','director','manager','ic','other')),
	CONSTRAINT "master_employment_confidence_range" CHECK ("master_employment"."confidence" IS NULL OR "master_employment"."confidence" BETWEEN 0 AND 1),
	CONSTRAINT "master_employment_ended_after_started" CHECK ("master_employment"."ended_on" IS NULL OR "master_employment"."ended_on" >= "master_employment"."started_on"),
	CONSTRAINT "master_employment_primary_is_current" CHECK ("master_employment"."is_primary" = false OR "master_employment"."is_current" = true)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_persons" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"linkedin_public_id" varchar(255),
	"full_name" varchar(255),
	"first_name" varchar(100),
	"last_name" varchar(100),
	"current_company_id" uuid,
	"job_title" varchar(255),
	"seniority_level" varchar(50),
	"department" varchar(100),
	"location_country" varchar(100),
	"location_city" varchar(100),
	"has_email" boolean DEFAULT false NOT NULL,
	"has_phone" boolean DEFAULT false NOT NULL,
	"data_quality_score" integer,
	"is_suppressed" boolean DEFAULT false NOT NULL,
	"region" char(2),
	"jurisdiction" char(2),
	"block_key" varchar(255),
	"field_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prov_hwm" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_persons_seniority_enum" CHECK ("master_persons"."seniority_level" IS NULL OR "master_persons"."seniority_level" IN ('c_suite','vp','director','manager','ic','other')),
	CONSTRAINT "master_persons_data_quality_range" CHECK ("master_persons"."data_quality_score" IS NULL OR "master_persons"."data_quality_score" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_phones" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"master_person_id" uuid NOT NULL,
	"phone_enc" "bytea" NOT NULL,
	"phone_blind_index" "bytea" NOT NULL,
	"line_type" varchar(20),
	"phone_status" varchar(50),
	"source_count" integer DEFAULT 1 NOT NULL,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "match_links" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"entity_type" varchar(10) NOT NULL,
	"cluster_id" uuid NOT NULL,
	"source_record_id" uuid NOT NULL,
	"match_probability" numeric(4, 3),
	"match_method" varchar(20) NOT NULL,
	"is_duplicate_of" uuid,
	"review_status" varchar(20) DEFAULT 'auto' NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_links_entity_type_enum" CHECK ("match_links"."entity_type" IN ('person','company')),
	CONSTRAINT "match_links_match_probability_range" CHECK ("match_links"."match_probability" IS NULL OR "match_links"."match_probability" BETWEEN 0 AND 1),
	CONSTRAINT "match_links_review_status_enum" CHECK ("match_links"."review_status" IN ('auto','pending','confirmed','rejected'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "source_records" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"source_name" varchar(50) NOT NULL,
	"content_hash" "bytea" NOT NULL,
	"raw_data" jsonb NOT NULL,
	"match_keys" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolved_person_id" uuid,
	"resolved_company_id" uuid,
	"lawful_basis_snapshot" jsonb,
	"region" char(2),
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "master_company_id" uuid;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "field_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "master_person_id" uuid;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "field_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "master_companies" ADD CONSTRAINT "master_companies_parent_company_id_master_companies_id_fk" FOREIGN KEY ("parent_company_id") REFERENCES "public"."master_companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "master_emails" ADD CONSTRAINT "master_emails_master_person_id_master_persons_id_fk" FOREIGN KEY ("master_person_id") REFERENCES "public"."master_persons"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "master_employment" ADD CONSTRAINT "master_employment_master_person_id_master_persons_id_fk" FOREIGN KEY ("master_person_id") REFERENCES "public"."master_persons"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "master_employment" ADD CONSTRAINT "master_employment_master_company_id_master_companies_id_fk" FOREIGN KEY ("master_company_id") REFERENCES "public"."master_companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "master_persons" ADD CONSTRAINT "master_persons_current_company_id_master_companies_id_fk" FOREIGN KEY ("current_company_id") REFERENCES "public"."master_companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "master_phones" ADD CONSTRAINT "master_phones_master_person_id_master_persons_id_fk" FOREIGN KEY ("master_person_id") REFERENCES "public"."master_persons"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "match_links" ADD CONSTRAINT "match_links_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "source_records" ADD CONSTRAINT "source_records_resolved_person_id_master_persons_id_fk" FOREIGN KEY ("resolved_person_id") REFERENCES "public"."master_persons"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "source_records" ADD CONSTRAINT "source_records_resolved_company_id_master_companies_id_fk" FOREIGN KEY ("resolved_company_id") REFERENCES "public"."master_companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_master_companies_primary_domain" ON "master_companies" USING btree ("primary_domain") WHERE "master_companies"."primary_domain" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_master_companies_linkedin" ON "master_companies" USING btree ("linkedin_company_id") WHERE "master_companies"."linkedin_company_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_master_emails_blind_index" ON "master_emails" USING btree ("email_blind_index");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_employment_stint" ON "master_employment" USING btree ("master_person_id","master_company_id","started_on");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_employment_primary" ON "master_employment" USING btree ("master_person_id") WHERE "master_employment"."is_primary";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_employment_current" ON "master_employment" USING btree ("master_person_id") WHERE "master_employment"."is_current";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_employment_company" ON "master_employment" USING btree ("master_company_id") WHERE "master_employment"."is_current";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_master_persons_linkedin" ON "master_persons" USING btree ("linkedin_public_id") WHERE "master_persons"."linkedin_public_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_master_persons_company" ON "master_persons" USING btree ("current_company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_master_phones_blind_index" ON "master_phones" USING btree ("phone_blind_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_match_links_cluster" ON "match_links" USING btree ("entity_type","cluster_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_source_records_content_hash" ON "source_records" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_source_records_employment" ON "source_records" USING btree ("resolved_person_id","resolved_company_id") WHERE "source_records"."resolved_person_id" IS NOT NULL AND "source_records"."resolved_company_id" IS NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounts" ADD CONSTRAINT "accounts_master_company_id_master_companies_id_fk" FOREIGN KEY ("master_company_id") REFERENCES "public"."master_companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contacts" ADD CONSTRAINT "contacts_master_person_id_master_persons_id_fk" FOREIGN KEY ("master_person_id") REFERENCES "public"."master_persons"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_accounts_master" ON "accounts" USING btree ("master_company_id") WHERE "accounts"."master_company_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contacts_master" ON "contacts" USING btree ("master_person_id") WHERE "contacts"."master_person_id" IS NOT NULL;