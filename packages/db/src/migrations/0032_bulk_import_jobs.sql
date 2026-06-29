CREATE TABLE IF NOT EXISTS "import_job_chunks" (
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
	CONSTRAINT "import_job_chunks_status_enum" CHECK ("import_job_chunks"."status" IN ('queued','running','paused','completed','partial','failed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "import_job_rows" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"job_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"row_index" integer NOT NULL,
	"workspace_id" uuid NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" varchar(20) DEFAULT 'unprocessed' NOT NULL,
	"reject_reason" text,
	"created_contact_id" uuid,
	"updated_contact_id" uuid,
	"matched_contact_id" uuid,
	"source_import_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_job_rows_outcome_enum" CHECK ("import_job_rows"."outcome" IN ('created','matched','duplicate','skipped','rejected','unprocessed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"source_file" varchar(1024) NOT NULL,
	"source_name" varchar(255) NOT NULL,
	"status" varchar(30) DEFAULT 'queued' NOT NULL,
	"file_size" bigint,
	"av_scan_status" varchar(20) DEFAULT 'pending' NOT NULL,
	"idempotency_key" varchar(255),
	"column_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"conflict_policy" varchar(20) DEFAULT 'skip' NOT NULL,
	"target_list_id" uuid,
	"staging_table" varchar(128),
	"byte_offset" bigint DEFAULT 0 NOT NULL,
	"total_chunks" integer DEFAULT 0 NOT NULL,
	"completed_chunks" integer DEFAULT 0 NOT NULL,
	"rows_total" integer DEFAULT 0 NOT NULL,
	"rows_created" integer DEFAULT 0 NOT NULL,
	"rows_matched" integer DEFAULT 0 NOT NULL,
	"rows_duplicate" integer DEFAULT 0 NOT NULL,
	"rows_skipped" integer DEFAULT 0 NOT NULL,
	"rows_rejected" integer DEFAULT 0 NOT NULL,
	"rows_deduped" integer DEFAULT 0 NOT NULL,
	"rows_unprocessed" integer DEFAULT 0 NOT NULL,
	"rejected_artifact_key" varchar(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_reason" text,
	CONSTRAINT "import_jobs_status_enum" CHECK ("import_jobs"."status" IN ('queued','validating','staged','running','paused','completed','partial','failed','cancelled')),
	CONSTRAINT "import_jobs_av_scan_status_enum" CHECK ("import_jobs"."av_scan_status" IN ('pending','clean','infected','skipped')),
	CONSTRAINT "import_jobs_conflict_policy_enum" CHECK ("import_jobs"."conflict_policy" IN ('overwrite','skip','keep_both'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_job_chunks" ADD CONSTRAINT "import_job_chunks_job_id_import_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."import_jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_job_rows" ADD CONSTRAINT "import_job_rows_job_id_import_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."import_jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_job_rows" ADD CONSTRAINT "import_job_rows_chunk_id_import_job_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."import_job_chunks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_job_rows" ADD CONSTRAINT "import_job_rows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_import_job_chunks_job_chunk" ON "import_job_chunks" USING btree ("job_id","chunk_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_import_job_rows_job" ON "import_job_rows" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_import_job_rows_ws_outcome" ON "import_job_rows" USING btree ("workspace_id","outcome");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_import_jobs_ws_status" ON "import_jobs" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_import_jobs_ws_idempotency" ON "import_jobs" USING btree ("workspace_id","idempotency_key") WHERE "import_jobs"."idempotency_key" IS NOT NULL;