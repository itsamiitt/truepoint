-- 0053_job_visibility_p0.sql — S-V1 (import-and-data-model-redesign 10 §S-V1; 15 §M-SEQ seq 2).
-- ADDITIVE ONLY; every object here is UNREAD while the JOB_VISIBILITY_SCOPED dual gate is off:
--   • shared_with_workspace on the 3 job tables — the §2.3 per-job share flag (column now, UX deferred;
--     written by nobody, read only by the jobVisibility predicate → constant false ⇒ zero behavior change);
--   • member-list keyset indexes (workspace_id, created_by_user_id, created_at DESC, id DESC) — the
--     narrowed member path of the predicate (+ the source_imports composite for the Recent Imports card);
--   • import_policy — one row per workspace (mirrors the enrichment_policy idiom): the G02
--     who_can_import knob + the 08 §5 strategy defaults (default_merge_mode / default_preserve_populated);
--   • P0 audit-action CHECK extension (ruling M1): exactly the one action Phase 0's writers need —
--     'import.policy_updated' (S-V4's audited policy write). Later phases extend the CHECK in their own trains.
--   • seed of the per-tenant 'job_visibility_scoped' flag (global_enabled=false, default=false — fail-closed,
--     mirroring 0034_seed_rollout_flags).
ALTER TABLE "import_jobs" ADD COLUMN IF NOT EXISTS "shared_with_workspace" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reveal_jobs" ADD COLUMN IF NOT EXISTS "shared_with_workspace" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "enrichment_jobs" ADD COLUMN IF NOT EXISTS "shared_with_workspace" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_import_jobs_ws_creator_created" ON "import_jobs" USING btree ("workspace_id","created_by_user_id","created_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reveal_jobs_ws_creator_created" ON "reveal_jobs" USING btree ("workspace_id","created_by_user_id","created_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_enrichment_jobs_ws_creator_created" ON "enrichment_jobs" USING btree ("workspace_id","created_by_user_id","created_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_source_imports_ws_importer_at" ON "source_imports" USING btree ("workspace_id","imported_by_user_id","imported_at" DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "import_policy" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"who_can_import" varchar(10) DEFAULT 'member' NOT NULL,
	"default_merge_mode" varchar(20) DEFAULT 'create_and_update' NOT NULL,
	"default_preserve_populated" boolean DEFAULT false NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_policy_who_can_import_enum" CHECK ("import_policy"."who_can_import" IN ('member','admin')),
	CONSTRAINT "import_policy_default_merge_mode_enum" CHECK ("import_policy"."default_merge_mode" IN ('create_and_update','create_only','update_only'))
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_policy" ADD CONSTRAINT "import_policy_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_policy" ADD CONSTRAINT "import_policy_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_policy" ADD CONSTRAINT "import_policy_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_import_policy_workspace" ON "import_policy" USING btree ("workspace_id");--> statement-breakpoint
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
        'import.policy_updated'
      ));--> statement-breakpoint
INSERT INTO feature_flags (key, description, global_enabled, "default") VALUES ('job_visibility_scoped', 'Per-tenant rollout gate for owner-scoped job visibility (import/reveal/enrichment lists + Recent Imports; import-and-data-model-redesign 10). OFF by default (fail-closed): while off every job surface keeps its shipped workspace-wide visibility, byte-identical. Effective only when the global JOB_VISIBILITY_SCOPED env kill-switch is also on; with both on, members see their own jobs and workspace admins/owners see all with creator attribution.', false, false) ON CONFLICT (key) DO NOTHING;

-- DOWN (manual, per 15 §R-P0 — all additive; safe while the dual gate is off):
--   DELETE FROM feature_flags WHERE key = 'job_visibility_scoped';
--   ALTER TABLE audit_log DROP CONSTRAINT audit_log_action_enum;  -- then re-ADD the 0015 list (without 'import.policy_updated')
--   DROP TABLE IF EXISTS import_policy;
--   DROP INDEX IF EXISTS idx_source_imports_ws_importer_at;
--   DROP INDEX IF EXISTS idx_enrichment_jobs_ws_creator_created;
--   DROP INDEX IF EXISTS idx_reveal_jobs_ws_creator_created;
--   DROP INDEX IF EXISTS idx_import_jobs_ws_creator_created;
--   ALTER TABLE enrichment_jobs DROP COLUMN IF EXISTS shared_with_workspace;
--   ALTER TABLE reveal_jobs DROP COLUMN IF EXISTS shared_with_workspace;
--   ALTER TABLE import_jobs DROP COLUMN IF EXISTS shared_with_workspace;
