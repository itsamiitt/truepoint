CREATE TABLE IF NOT EXISTS "retention_class_policies" (
	"data_class" varchar(50) PRIMARY KEY NOT NULL,
	"ttl_days" integer,
	"mode" varchar(20) DEFAULT 'shadow' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_class_policies_mode_enum" CHECK ("retention_class_policies"."mode" IN ('disabled','shadow','enforce'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retention_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"data_class" varchar(50) NOT NULL,
	"mode" varchar(20) NOT NULL,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"deleted_count" integer DEFAULT 0 NOT NULL,
	"cutoff" timestamp with time zone,
	"run_started_at" timestamp with time zone NOT NULL,
	"run_finished_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_runs_mode_enum" CHECK ("retention_runs"."mode" IN ('disabled','shadow','enforce'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "retention_runs" ADD CONSTRAINT "retention_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_retention_runs_tenant_class" ON "retention_runs" USING btree ("tenant_id","data_class","created_at");--> statement-breakpoint
INSERT INTO retention_class_policies (data_class, ttl_days, mode) VALUES ('email_event', 90, 'shadow') ON CONFLICT (data_class) DO NOTHING;--> statement-breakpoint
INSERT INTO retention_class_policies (data_class, ttl_days, mode) VALUES ('provider_calls', 90, 'shadow') ON CONFLICT (data_class) DO NOTHING;--> statement-breakpoint
INSERT INTO retention_class_policies (data_class, ttl_days, mode) VALUES ('enrichment_job_rows', 365, 'shadow') ON CONFLICT (data_class) DO NOTHING;--> statement-breakpoint
INSERT INTO retention_class_policies (data_class, ttl_days, mode) VALUES ('import_job_rows', 365, 'shadow') ON CONFLICT (data_class) DO NOTHING;--> statement-breakpoint
INSERT INTO retention_class_policies (data_class, ttl_days, mode) VALUES ('data_quality_snapshots', 730, 'shadow') ON CONFLICT (data_class) DO NOTHING;--> statement-breakpoint
INSERT INTO retention_class_policies (data_class, ttl_days, mode) VALUES ('verification_jobs', 730, 'shadow') ON CONFLICT (data_class) DO NOTHING;--> statement-breakpoint
INSERT INTO retention_class_policies (data_class, ttl_days, mode) VALUES ('activities', 365, 'shadow') ON CONFLICT (data_class) DO NOTHING;--> statement-breakpoint
INSERT INTO retention_class_policies (data_class, ttl_days, mode) VALUES ('contact_reveals', 180, 'shadow') ON CONFLICT (data_class) DO NOTHING;--> statement-breakpoint
INSERT INTO retention_class_policies (data_class, ttl_days, mode) VALUES ('source_imports', 730, 'shadow') ON CONFLICT (data_class) DO NOTHING;--> statement-breakpoint
INSERT INTO retention_class_policies (data_class, ttl_days, mode) VALUES ('consent_records', 180, 'shadow') ON CONFLICT (data_class) DO NOTHING;--> statement-breakpoint
INSERT INTO retention_class_policies (data_class, ttl_days, mode) VALUES ('contacts', NULL, 'shadow') ON CONFLICT (data_class) DO NOTHING;--> statement-breakpoint
INSERT INTO retention_class_policies (data_class, ttl_days, mode) VALUES ('audit_log', NULL, 'shadow') ON CONFLICT (data_class) DO NOTHING;
