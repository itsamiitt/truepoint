CREATE TABLE "master_company_contact_points" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"master_company_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"value_normalized" "citext" NOT NULL,
	"value_blind_index" "bytea",
	"verification_status" varchar(20) DEFAULT 'unverified' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"source_count" integer DEFAULT 1 NOT NULL,
	"confidence" numeric(4, 3),
	"source_name" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_company_contact_points_kind_enum" CHECK ("master_company_contact_points"."kind" IN ('switchboard','generic_email','fax')),
	CONSTRAINT "master_company_contact_points_status_enum" CHECK ("master_company_contact_points"."verification_status" IN ('unverified','valid','risky','invalid','unknown'))
);
--> statement-breakpoint
CREATE TABLE "master_company_funding" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"master_company_id" uuid NOT NULL,
	"round_type" varchar(30),
	"amount_minor" bigint,
	"currency" char(3),
	"announced_on" date,
	"lead_investor_company_id" uuid,
	"confidence" numeric(4, 3),
	"source_name" varchar(50),
	"evidence_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_company_funding_amount_needs_currency" CHECK (("master_company_funding"."amount_minor" IS NULL AND "master_company_funding"."currency" IS NULL)
          OR ("master_company_funding"."amount_minor" IS NOT NULL AND "master_company_funding"."currency" IS NOT NULL)),
	CONSTRAINT "master_company_funding_confidence_range" CHECK ("master_company_funding"."confidence" IS NULL OR "master_company_funding"."confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "master_company_locations" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"master_company_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"address_line" varchar(255),
	"city" varchar(120),
	"region" varchar(120),
	"country_code" char(2),
	"postal_code" varchar(20),
	"source_count" integer DEFAULT 1 NOT NULL,
	"confidence" numeric(4, 3),
	"source_name" varchar(50),
	"observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_company_locations_kind_enum" CHECK ("master_company_locations"."kind" IN ('hq','office','plant','registered')),
	CONSTRAINT "master_company_locations_confidence_range" CHECK ("master_company_locations"."confidence" IS NULL OR "master_company_locations"."confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "master_person_identifiers" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"master_person_id" uuid NOT NULL,
	"id_type" varchar(40) NOT NULL,
	"id_value" "citext" NOT NULL,
	"source_name" varchar(50),
	"observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "master_company_contact_points" ADD CONSTRAINT "master_company_contact_points_master_company_id_master_companies_id_fk" FOREIGN KEY ("master_company_id") REFERENCES "public"."master_companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_company_funding" ADD CONSTRAINT "master_company_funding_master_company_id_master_companies_id_fk" FOREIGN KEY ("master_company_id") REFERENCES "public"."master_companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_company_funding" ADD CONSTRAINT "master_company_funding_lead_investor_company_id_master_companies_id_fk" FOREIGN KEY ("lead_investor_company_id") REFERENCES "public"."master_companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_company_locations" ADD CONSTRAINT "master_company_locations_master_company_id_master_companies_id_fk" FOREIGN KEY ("master_company_id") REFERENCES "public"."master_companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_person_identifiers" ADD CONSTRAINT "master_person_identifiers_master_person_id_master_persons_id_fk" FOREIGN KEY ("master_person_id") REFERENCES "public"."master_persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_master_company_contact_point" ON "master_company_contact_points" USING btree ("master_company_id","kind","value_normalized");--> statement-breakpoint
CREATE INDEX "idx_master_company_contact_blind_index" ON "master_company_contact_points" USING btree ("value_blind_index") WHERE "master_company_contact_points"."value_blind_index" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_master_company_funding_company" ON "master_company_funding" USING btree ("master_company_id","announced_on" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_master_company_funding_round" ON "master_company_funding" USING btree ("master_company_id","round_type","announced_on");--> statement-breakpoint
CREATE INDEX "idx_master_company_funding_investor" ON "master_company_funding" USING btree ("lead_investor_company_id") WHERE "master_company_funding"."lead_investor_company_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_master_company_locations_company" ON "master_company_locations" USING btree ("master_company_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_master_company_hq" ON "master_company_locations" USING btree ("master_company_id") WHERE "master_company_locations"."kind" = 'hq';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_master_person_identifier" ON "master_person_identifiers" USING btree ("id_type","id_value");--> statement-breakpoint
CREATE INDEX "idx_master_person_identifier_person" ON "master_person_identifiers" USING btree ("master_person_id");--> statement-breakpoint

-- ── HAND-APPENDED BACKFILL (everything above this line is drizzle-kit generated) ────────────────────────
-- Copy the existing master_persons.linkedin_public_id column into the new general identifier table so the
-- two agree from the moment the table exists. The COLUMN IS NOT DROPPED and is not going to be: it is a hot,
-- indexed, widely-referenced single-column lookup, and removing it would be a wide, risky refactor for no
-- outcome. This table generalizes ADDITIONAL identifiers (audit D8: one column per source meant every new
-- provider was a migration); it does not replace the primary one.
--
-- Non-destructive and idempotent: an INSERT ... SELECT with ON CONFLICT DO NOTHING against the global
-- (id_type, id_value) unique. Re-running changes nothing. It reads master_persons and writes only the new
-- table.
--
-- Bounded by the number of master_persons rows carrying a linkedin_public_id, which is small today (the
-- Layer-0 ingest paths are not yet mass-populating the graph). If that ever stops being true, this belongs
-- in a batched sweep rather than a migration — a single unbounded INSERT ... SELECT in a deploy path is how
-- a migration turns into an outage.
INSERT INTO master_person_identifiers (master_person_id, id_type, id_value, source_name, observed_at)
SELECT id, 'linkedin_public_id', linkedin_public_id, 'backfill_0104', created_at
  FROM master_persons
 WHERE linkedin_public_id IS NOT NULL
ON CONFLICT DO NOTHING;