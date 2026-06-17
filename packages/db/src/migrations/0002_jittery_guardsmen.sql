CREATE TABLE IF NOT EXISTS "enrichment_job_chunks" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"job_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"row_start" integer NOT NULL,
	"row_end" integer NOT NULL,
	"status" varchar(30) DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "enrichment_job_chunks_status_enum" CHECK ("enrichment_job_chunks"."status" IN ('queued','estimating','awaiting_confirmation','running','paused','completed','failed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "enrichment_job_rows" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"job_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"row_index" integer NOT NULL,
	"workspace_id" uuid NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"match_method" varchar(30) DEFAULT 'none' NOT NULL,
	"match_outcome" varchar(30) DEFAULT 'unmatched' NOT NULL,
	"matched_contact_id" uuid,
	"matched_master_person_id" uuid,
	"match_confidence" numeric(5, 4),
	"enriched_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_source" varchar(50),
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"charged" boolean DEFAULT false NOT NULL,
	"email_status" varchar(20) DEFAULT 'unverified' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrichment_job_rows_match_method_enum" CHECK ("enrichment_job_rows"."match_method" IN ('deterministic_email','deterministic_linkedin','deterministic_phone','deterministic_domain','fuzzy_name_company','provider','none')),
	CONSTRAINT "enrichment_job_rows_match_outcome_enum" CHECK ("enrichment_job_rows"."match_outcome" IN ('matched_internal','matched_provider','unmatched','suppressed','error')),
	CONSTRAINT "enrichment_job_rows_email_status_enum" CHECK ("enrichment_job_rows"."email_status" IN ('unverified','valid','risky','invalid','catch_all','unknown')),
	CONSTRAINT "enrichment_job_rows_confidence_range" CHECK ("enrichment_job_rows"."match_confidence" IS NULL OR "enrichment_job_rows"."match_confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "enrichment_jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"source_file" varchar(1024) NOT NULL,
	"source_name" varchar(255) NOT NULL,
	"status" varchar(30) DEFAULT 'queued' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"matched_rows" integer DEFAULT 0 NOT NULL,
	"enriched_rows" integer DEFAULT 0 NOT NULL,
	"charged_rows" integer DEFAULT 0 NOT NULL,
	"credit_estimate_micros" bigint,
	"credit_spent_micros" bigint DEFAULT 0 NOT NULL,
	"column_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_reason" text,
	CONSTRAINT "enrichment_jobs_status_enum" CHECK ("enrichment_jobs"."status" IN ('queued','estimating','awaiting_confirmation','running','paused','completed','failed','cancelled'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrichment_job_chunks" ADD CONSTRAINT "enrichment_job_chunks_job_id_enrichment_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."enrichment_jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrichment_job_rows" ADD CONSTRAINT "enrichment_job_rows_job_id_enrichment_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."enrichment_jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrichment_job_rows" ADD CONSTRAINT "enrichment_job_rows_chunk_id_enrichment_job_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."enrichment_job_chunks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrichment_job_rows" ADD CONSTRAINT "enrichment_job_rows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrichment_job_rows" ADD CONSTRAINT "enrichment_job_rows_matched_contact_id_contacts_id_fk" FOREIGN KEY ("matched_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrichment_jobs" ADD CONSTRAINT "enrichment_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrichment_jobs" ADD CONSTRAINT "enrichment_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrichment_jobs" ADD CONSTRAINT "enrichment_jobs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_enrichment_job_chunks_job_chunk" ON "enrichment_job_chunks" USING btree ("job_id","chunk_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_enrichment_job_rows_job" ON "enrichment_job_rows" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_enrichment_job_rows_ws_outcome" ON "enrichment_job_rows" USING btree ("workspace_id","match_outcome");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_enrichment_jobs_ws_status" ON "enrichment_jobs" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_enrichment_jobs_ws_idempotency" ON "enrichment_jobs" USING btree ("workspace_id","idempotency_key") WHERE "enrichment_jobs"."idempotency_key" IS NOT NULL;