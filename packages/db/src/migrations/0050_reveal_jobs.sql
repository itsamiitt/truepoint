CREATE TABLE IF NOT EXISTS "reveal_jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"reveal_type" varchar(20) NOT NULL,
	"status" varchar(30) DEFAULT 'queued' NOT NULL,
	"total_contacts" integer DEFAULT 0 NOT NULL,
	"processed_contacts" integer DEFAULT 0 NOT NULL,
	"revealed_contacts" integer DEFAULT 0 NOT NULL,
	"already_owned_contacts" integer DEFAULT 0 NOT NULL,
	"suppressed_contacts" integer DEFAULT 0 NOT NULL,
	"failed_contacts" integer DEFAULT 0 NOT NULL,
	"credit_estimate" integer DEFAULT 0 NOT NULL,
	"credit_leased" integer DEFAULT 0 NOT NULL,
	"credit_leased_from_sub" integer DEFAULT 0 NOT NULL,
	"credit_spent" integer DEFAULT 0 NOT NULL,
	"result_key" varchar(1024),
	"idempotency_key" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_reason" varchar(1024),
	CONSTRAINT "reveal_jobs_status_enum" CHECK ("reveal_jobs"."status" IN ('queued','estimating','awaiting_confirmation','running','paused','completed','failed','cancelled')),
	CONSTRAINT "reveal_jobs_reveal_type_enum" CHECK ("reveal_jobs"."reveal_type" IN ('email','phone','full_profile'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reveal_job_rows" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"job_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid,
	"row_index" integer NOT NULL,
	"outcome" varchar(20) DEFAULT 'queued' NOT NULL,
	"credits_charged" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reveal_job_rows_outcome_enum" CHECK ("reveal_job_rows"."outcome" IN ('queued','revealed','already_owned','suppressed','insufficient','error'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reveal_jobs" ADD CONSTRAINT "reveal_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reveal_jobs" ADD CONSTRAINT "reveal_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reveal_jobs" ADD CONSTRAINT "reveal_jobs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reveal_job_rows" ADD CONSTRAINT "reveal_job_rows_job_id_reveal_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."reveal_jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reveal_job_rows" ADD CONSTRAINT "reveal_job_rows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reveal_job_rows" ADD CONSTRAINT "reveal_job_rows_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reveal_jobs_ws_status" ON "reveal_jobs" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_reveal_jobs_ws_idempotency" ON "reveal_jobs" USING btree ("workspace_id","idempotency_key") WHERE "reveal_jobs"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_reveal_job_rows_job_contact" ON "reveal_job_rows" USING btree ("job_id","contact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reveal_job_rows_job_row" ON "reveal_job_rows" USING btree ("job_id","row_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reveal_job_rows_ws_outcome" ON "reveal_job_rows" USING btree ("workspace_id","outcome");
