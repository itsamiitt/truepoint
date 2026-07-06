-- 0063_scheduled_imports.sql — P5 SCHEDULED IMPORTS (import-and-data-model-redesign 08 §9 "Scheduled imports"
-- · 14 Phase 5 · 15 §M-SEQ open P5 band). NEW TABLE + per-tenant flag seed; every object here is UNREAD/INERT
-- while the SCHEDULED_IMPORTS_ENABLED env kill-switch + the per-tenant `scheduled_imports_enabled` flag are off.
--
-- The table holds a per-workspace recurring import DEFINITION (cadence + a STORED source object + the
-- replayable mapping/strategy). The leader-locked scheduledImportSweep fires due rows by submitting an
-- ordinary `import_jobs` row through the EXISTING durable pipeline (submitCopyImport) — 08 §9: "creates an
-- ordinary import_jobs row — same trio, same machine". No new execution machinery.
--
-- SOURCE MODEL (08 §9 pins two branches: "connected source OR a re-uploaded template file"). This v1 ships
-- ONLY the STORED-OBJECT branch (`source_object_key` names an object already in the FileStore). The remote-URL
-- / connected-source branch is DEFERRED — it takes URLs+credentials and is bound by 13 §8's SSRF forward-guard
-- (deny-by-default egress, allowlist, the shipped ssrfGuard reuse), acceptance criteria for when it is built.
-- Nothing here fetches an outbound URL, so this v1 opens NO SSRF surface.
--
-- CADENCE (08 §9 said "cron"): this v1 ships an INTERVAL ENUM (hourly/daily/weekly) — a `cadence` varchar+CHECK
-- so a cron string can be added later without a rename. All additive; workspace-scoped RLS in
-- rls/scheduledImports.sql (applied in migrate step [3/4]).
CREATE TABLE IF NOT EXISTS "scheduled_imports" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "created_by_user_id" uuid,
  "name" varchar(120) NOT NULL,
  "source_name" varchar(40) NOT NULL,
  "source_object_key" varchar(512) NOT NULL,
  "source_filename" varchar(255),
  "mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "merge_mode" varchar(20),
  "preserve_populated" boolean,
  "target_list_id" uuid,
  "options" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "cadence" varchar(20) NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "disabled_reason" varchar(20),
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "next_run_at" timestamp with time zone NOT NULL,
  "last_run_at" timestamp with time zone,
  "last_job_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_imports" ADD CONSTRAINT "scheduled_imports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_imports" ADD CONSTRAINT "scheduled_imports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_imports" ADD CONSTRAINT "scheduled_imports_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_imports" ADD CONSTRAINT "scheduled_imports_cadence_enum" CHECK ("scheduled_imports"."cadence" IN ('hourly','daily','weekly'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_imports" ADD CONSTRAINT "scheduled_imports_merge_mode_enum" CHECK ("scheduled_imports"."merge_mode" IN ('create_and_update','create_only','update_only'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_imports" ADD CONSTRAINT "scheduled_imports_disabled_reason_enum" CHECK ("scheduled_imports"."disabled_reason" IN ('grant_lost','max_failures'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_scheduled_imports_ws_lower_name" ON "scheduled_imports" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scheduled_imports_due" ON "scheduled_imports" USING btree ("next_run_at") WHERE "scheduled_imports"."enabled" = true;--> statement-breakpoint
INSERT INTO feature_flags (key, description, global_enabled, "default") VALUES ('scheduled_imports_enabled', 'Per-tenant rollout gate for scheduled imports (import-and-data-model-redesign 08 §9; P5). OFF by default (fail-closed): while off the scheduled-imports CRUD verbs 404 and the leader-locked sweep fires nothing for the tenant — the table stays inert. Effective only when the global SCHEDULED_IMPORTS_ENABLED env kill-switch is also on AND the import_v2 dual gate is on for the tenant (a fired run rides the unified durable pipeline). With all on, due schedules submit an ordinary import_jobs row through submitCopyImport over their stored source object.', false, false) ON CONFLICT (key) DO NOTHING;

-- DOWN (manual, per 15 §R-P5 — all additive; safe while both gates are off):
--   DELETE FROM feature_flags WHERE key = 'scheduled_imports_enabled';
--   DROP TABLE IF EXISTS scheduled_imports;  -- (drops its indexes + constraints)
