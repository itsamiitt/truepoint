-- 0054_import_v2_p1.sql — S-I1 (import-and-data-model-redesign 08 §Implementation Steps; 15 §M-SEQ seq 7).
-- ADDITIVE ONLY; every object here is UNREAD while the IMPORT_V2_ENABLED dual gate is off:
--   • import_jobs unified-job columns (08 §2/§3/§5/§6.3): processing_mode (server-side routing verdict,
--     'fast'|'copy'; NULL = legacy row, not yet routed) · merge_mode + preserve_populated (the 08 §5.1
--     strategy pair, defaults mirroring import_policy) · parent_job_id (retry-child self-FK, SET NULL —
--     08 §6.3) · source_filename (display filename; source_name holds the SourceName provider enum, NOT the
--     filename, despite its inline comment — 08 §Contradiction scan) · mapping_template_id (template
--     provenance FK, SET NULL — 08 §3.1) · options jsonb (countryHint / primary-from-column / delimiter…,
--     shape owned by S-I5/S-I8) · preview_summary jsonb (non-PII projection cache, 08 §4; NULL = never
--     previewed);
--   • status-CHECK extension: the shipped 9 states + 'draft'/'uploading'/'deferred' (08 §2.1 — all 9 kept,
--     none dropped; new states written by nobody until S-I8/S-Q2);
--   • the keyset list index (workspace_id, created_at DESC, id DESC) — 07 §4.3 flagged it missing for
--     GET /imports (listJobsByWorkspace orders by it with no backing composite today);
--   • P1 audit-action CHECK extension (ruling M1, 15 §Mismatches): exactly the actions Phase-1 writers emit —
--     'import.committed','import.cancelled','import.retry_created','import.template_saved',
--     'import.artifact_downloaded' ('import.draft_reaped'/'import.av_infected' are P2 and ride that train);
--   • seed of the per-tenant 'import_v2_enabled' flag (global_enabled=false, default=false — fail-closed,
--     mirroring 0053's seed; S-I3's dual gate reads it).
ALTER TABLE "import_jobs" ADD COLUMN IF NOT EXISTS "processing_mode" varchar(10);--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN IF NOT EXISTS "merge_mode" varchar(20) DEFAULT 'create_and_update' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN IF NOT EXISTS "preserve_populated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN IF NOT EXISTS "parent_job_id" uuid;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN IF NOT EXISTS "source_filename" varchar(255);--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN IF NOT EXISTS "mapping_template_id" uuid;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN IF NOT EXISTS "options" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN IF NOT EXISTS "preview_summary" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_parent_job_id_import_jobs_id_fk" FOREIGN KEY ("parent_job_id") REFERENCES "public"."import_jobs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_mapping_template_id_import_mapping_templates_id_fk" FOREIGN KEY ("mapping_template_id") REFERENCES "public"."import_mapping_templates"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_processing_mode_enum" CHECK ("import_jobs"."processing_mode" IN ('fast','copy'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_merge_mode_enum" CHECK ("import_jobs"."merge_mode" IN ('create_and_update','create_only','update_only'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "import_jobs" DROP CONSTRAINT "import_jobs_status_enum";--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_status_enum" CHECK ("import_jobs"."status" IN ('queued','validating','staged','running','paused','completed','partial','failed','cancelled','draft','uploading','deferred'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_import_jobs_ws_created" ON "import_jobs" USING btree ("workspace_id","created_at" DESC,"id" DESC);--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_enum";--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_enum" CHECK ("audit_log"."action" IN (
        'reveal','reveal.blocked','export','send','enroll','unsubscribe',
        'suppression.add','suppression.remove','consent.record','consent.withdraw',
        'dsar.access','dsar.delete','dsar.rectify','member.add','member.update','member.remove',
        'apikey.use','credit.adjust',
        'contact.create','contact.update','contact.delete','account.create','account.update','account.delete',
        'list.create','list.update','list.delete','sequence.create','sequence.update','sequence.delete',
        'template.create','template.update','template.delete','settings.update',
        'automation.rule.create','automation.rule.update','automation.rule.delete',
        'custom_field.create','custom_field.update','custom_field.delete',
        'tag.create','tag.update','tag.delete','tag.assign','tag.unassign',
        'pipeline_stage.create','pipeline_stage.update','pipeline_stage.delete','pipeline_stage.assign',
        'saved_search.create','saved_search.update','saved_search.delete',
        'automation.rule.enable','automation.rule.disable','automation.rule.run',
        'ai.config.update','ai.draft.approve','ai.draft.reject',
        'mailbox.connect','mailbox.disconnect','sending_domain.add','sending_domain.verify',
        'login.success','login.failure','login.locked','mfa.challenge','mfa.success','mfa.failure',
        'password.reset.request','password.reset.complete','sso.initiated','sso.callback',
        'token.issued','token.refresh','token.revoke','device.trusted','device.revoked','session.revoked',
        'code.issued','code.exchanged','signup','oauth.link',
        'import.policy_updated',
        'import.committed','import.cancelled','import.retry_created','import.template_saved','import.artifact_downloaded'
      ));--> statement-breakpoint
INSERT INTO feature_flags (key, description, global_enabled, "default") VALUES ('import_v2_enabled', 'Per-tenant rollout gate for the unified durable import pipeline (import-and-data-model-redesign 08; S-I3 dual-write onward). OFF by default (fail-closed): while off every import surface keeps its shipped behavior, byte-identical — the 0054 columns/states stay unread. Effective only when the global IMPORT_V2_ENABLED env kill-switch is also on; with both on, fast-path imports dual-write durable import_jobs rows and the v2 list/detail/cancel surfaces activate as their steps ship.', false, false) ON CONFLICT (key) DO NOTHING;

-- DOWN (manual, per 15 §R-P1 — all additive; safe while the dual gate is off):
--   DELETE FROM feature_flags WHERE key = 'import_v2_enabled';
--   ALTER TABLE audit_log DROP CONSTRAINT audit_log_action_enum;  -- then re-ADD the 0053 list (without the five 'import.*' P1 actions)
--   DROP INDEX IF EXISTS idx_import_jobs_ws_created;
--   ALTER TABLE import_jobs DROP CONSTRAINT import_jobs_status_enum;  -- then re-ADD the 9-state 0032 list
--   ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_merge_mode_enum;
--   ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_processing_mode_enum;
--   ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_mapping_template_id_import_mapping_templates_id_fk;
--   ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_parent_job_id_import_jobs_id_fk;
--   ALTER TABLE import_jobs DROP COLUMN IF EXISTS preview_summary;
--   ALTER TABLE import_jobs DROP COLUMN IF EXISTS options;
--   ALTER TABLE import_jobs DROP COLUMN IF EXISTS mapping_template_id;
--   ALTER TABLE import_jobs DROP COLUMN IF EXISTS source_filename;
--   ALTER TABLE import_jobs DROP COLUMN IF EXISTS parent_job_id;
--   ALTER TABLE import_jobs DROP COLUMN IF EXISTS preserve_populated;
--   ALTER TABLE import_jobs DROP COLUMN IF EXISTS merge_mode;
--   ALTER TABLE import_jobs DROP COLUMN IF EXISTS processing_mode;
