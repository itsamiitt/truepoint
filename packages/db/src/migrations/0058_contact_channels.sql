-- 0058_contact_channels.sql — S-CH1 (import-and-data-model-redesign 05 §1–§2/§7; 07 §3/§4/§8; 15 §M-SEQ seq 44).
-- DDL EXPAND ONLY — dead schema: NOTHING reads or writes `contact_emails`/`contact_phones` until S-CH2
-- (dual-write via `applyChannelWrite`, `CHANNEL_DUAL_WRITE`-gated). Everything here is additive and inert:
--   • the two overlay child tables per 05 §1 (one shared shape + per-table deltas): uuid_generate_v7 ids,
--     denormalized NOT NULL tenant_id + workspace_id on every row (RLS never derives scope through the
--     parent join — the import_job_rows precedent), AES-GCM `value_enc` + HMAC `blind_index` (DM1
--     primitives; emails also carry the clear non-PII `email_domain` facet; phones the dual representation
--     `e164_enc`/`e164_blind_index` + `raw_original_enc` + `country_hint` + `extension` outside the E.164
--     core + `line_type`/`line_type_source`), per-value verification/provenance columns
--     (status/confidence/source/source_import_id/pinned/first_seen_at/last_verified_at), soft-delete;
--   • CHECKs enumerate the SHIPPED vocabularies (DM1, reused never re-derived): email status =
--     contacts_email_status_enum's 6; phone status = the phoneStatus zod 6 (nullable, like
--     contacts.phone_status); type per 05 §1.4 (emails work|personal|other; phones +mobile|direct|hq);
--     line_type = 05 §1.5's 14-value union taxonomy (phoneLineType widened IN PLACE, additively);
--   • the 05 §2.2 DELIBERATE ASYMMETRY (07 §1 axis 3 verified): emails are per-WORKSPACE value-unique
--     (`uniq_contact_emails_ws_value` — the any-value identity rung) + per-contact unique; phones are
--     per-CONTACT unique ONLY (shared HQ/switchboard lines are legal) with the NON-unique
--     `idx_contact_phones_ws_e164` workspace match-SIGNAL probe (never an upsert key);
--   • at-most-one live primary per contact per table (`uniq_*_primary` partial uniques; exactly-one is the
--     app-level CH-INV-1 invariant, S-CH2/S-CH5's);
--   • the `(workspace_id, contact_id)` fetch composites + the `idx_contact_emails_ws_domain` any-value
--     domain facet (G16). Index budget 6/table incl. PK (05 §2.3) — emails 6, phones 5;
--   • FKs per 07 §3: contact_id → contacts CASCADE (hard-purge fanout ONLY; product delete is soft via
--     deleted_at), source_import_id → source_imports SET NULL (retention may reap lineage at 730 d),
--     tenant/workspace → CASCADE;
--   • ⚠ the S-P5 tripwire (0056, 16 drift row 2026-07-05): 0056's autovacuum params for these two tables
--     were to_regclass-guarded no-ops on any DB migrated before this — RE-STATED here, same numbers;
--   • retention-class seed rows `contact_emails`/`contact_phones` (ttl NULL, shadow — mirror `contacts`,
--     05 §7; deletes nothing until a human flips enforce + the engine flag);
--   • P3 audit-action CHECK extension (ruling M1, 15 §Mismatches: once per phase, in that phase's train,
--     BEFORE the first writer): 05 §7's four `channel_*` actions — written by nobody until S-CH2.
-- RLS (ENABLE+FORCE, fail-closed NULLIF workspace GUC) + grants + set_updated_at triggers live in
-- rls/contactChannels.sql (applied by applyMigrations' rls/*.sql pass, per the one-file-per-schema-unit
-- convention). Per-contact caps (25/channel) are APP-LAYER (05 §Misuse), enforced at the API edge — no DDL.
CREATE TABLE IF NOT EXISTS "contact_emails" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"value_enc" bytea NOT NULL,
	"blind_index" bytea NOT NULL,
	"email_domain" citext NOT NULL,
	"type" varchar(20) DEFAULT 'other' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"status" varchar(20) DEFAULT 'unverified' NOT NULL,
	"confidence" numeric(3,2),
	"source" varchar(50) NOT NULL,
	"source_import_id" uuid,
	"pinned" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_emails_type_enum" CHECK ("contact_emails"."type" IN ('work','personal','other')),
	CONSTRAINT "contact_emails_status_enum" CHECK ("contact_emails"."status" IN ('unverified','valid','risky','invalid','catch_all','unknown')),
	CONSTRAINT "contact_emails_confidence_range" CHECK ("contact_emails"."confidence" IS NULL OR "contact_emails"."confidence" BETWEEN 0 AND 1)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_phones" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"value_enc" bytea NOT NULL,
	"blind_index" bytea NOT NULL,
	"e164_enc" bytea,
	"e164_blind_index" bytea,
	"raw_original_enc" bytea,
	"country_hint" char(2),
	"extension" varchar(16),
	"line_type" varchar(24),
	"line_type_source" varchar(20),
	"type" varchar(20) DEFAULT 'other' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"status" varchar(50),
	"confidence" numeric(3,2),
	"source" varchar(50) NOT NULL,
	"source_import_id" uuid,
	"pinned" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_phones_type_enum" CHECK ("contact_phones"."type" IN ('work','personal','mobile','direct','hq','other')),
	CONSTRAINT "contact_phones_status_enum" CHECK ("contact_phones"."status" IS NULL OR "contact_phones"."status" IN ('direct','mobile','hq','unknown','valid','invalid')),
	CONSTRAINT "contact_phones_line_type_enum" CHECK ("contact_phones"."line_type" IS NULL OR "contact_phones"."line_type" IN ('mobile','landline','fixed_voip','non_fixed_voip','voip','toll_free','premium_rate','shared_cost','personal','pager','uan','voicemail','fixed_line_or_mobile','unknown')),
	CONSTRAINT "contact_phones_line_type_source_enum" CHECK ("contact_phones"."line_type_source" IS NULL OR "contact_phones"."line_type_source" IN ('carrier_lookup','libphonenumber','provider','import')),
	CONSTRAINT "contact_phones_confidence_range" CHECK ("contact_phones"."confidence" IS NULL OR "contact_phones"."confidence" BETWEEN 0 AND 1)
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contact_emails" ADD CONSTRAINT "contact_emails_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contact_emails" ADD CONSTRAINT "contact_emails_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contact_emails" ADD CONSTRAINT "contact_emails_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contact_emails" ADD CONSTRAINT "contact_emails_source_import_id_source_imports_id_fk" FOREIGN KEY ("source_import_id") REFERENCES "public"."source_imports"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contact_phones" ADD CONSTRAINT "contact_phones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contact_phones" ADD CONSTRAINT "contact_phones_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contact_phones" ADD CONSTRAINT "contact_phones_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contact_phones" ADD CONSTRAINT "contact_phones_source_import_id_source_imports_id_fk" FOREIGN KEY ("source_import_id") REFERENCES "public"."source_imports"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_contact_emails_primary" ON "contact_emails" USING btree ("contact_id") WHERE "contact_emails"."is_primary" AND "contact_emails"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_contact_emails_ws_value" ON "contact_emails" USING btree ("workspace_id","blind_index") WHERE "contact_emails"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_contact_emails_contact_value" ON "contact_emails" USING btree ("contact_id","blind_index") WHERE "contact_emails"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_emails_ws_contact" ON "contact_emails" USING btree ("workspace_id","contact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_emails_ws_domain" ON "contact_emails" USING btree ("workspace_id","email_domain") WHERE "contact_emails"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_contact_phones_primary" ON "contact_phones" USING btree ("contact_id") WHERE "contact_phones"."is_primary" AND "contact_phones"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_contact_phones_contact_value" ON "contact_phones" USING btree ("contact_id","blind_index") WHERE "contact_phones"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_phones_ws_e164" ON "contact_phones" USING btree ("workspace_id","e164_blind_index") WHERE "contact_phones"."e164_blind_index" IS NOT NULL AND "contact_phones"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_phones_ws_contact" ON "contact_phones" USING btree ("workspace_id","contact_id");--> statement-breakpoint
ALTER TABLE "contact_emails" SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_threshold = 10000,
  autovacuum_vacuum_insert_scale_factor = 0.01,
  autovacuum_vacuum_insert_threshold = 100000,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_analyze_threshold = 10000
);--> statement-breakpoint
ALTER TABLE "contact_phones" SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_threshold = 10000,
  autovacuum_vacuum_insert_scale_factor = 0.01,
  autovacuum_vacuum_insert_threshold = 100000,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_analyze_threshold = 10000
);--> statement-breakpoint
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
        'import.committed','import.cancelled','import.retry_created','import.template_saved','import.artifact_downloaded',
        'import.av_infected','import.draft_reaped',
        'channel_added','channel_promoted','channel_deleted','channel_primary_demoted'
      ));--> statement-breakpoint
INSERT INTO retention_class_policies (data_class, ttl_days, mode) VALUES ('contact_emails', NULL, 'shadow') ON CONFLICT (data_class) DO NOTHING;--> statement-breakpoint
INSERT INTO retention_class_policies (data_class, ttl_days, mode) VALUES ('contact_phones', NULL, 'shadow') ON CONFLICT (data_class) DO NOTHING;

-- DOWN (manual, per 15 §R-P3 — droppable ONLY in the never-written case, i.e. before S-CH2 ever ran):
--   DELETE FROM retention_class_policies WHERE data_class IN ('contact_emails','contact_phones');
--   ALTER TABLE audit_log DROP CONSTRAINT audit_log_action_enum;  -- then re-ADD the 0057 list (without the four 'channel_*' P3 actions)
--   DROP TABLE IF EXISTS contact_phones;  -- drops its indexes, CHECKs, FKs, policies, triggers with it
--   DROP TABLE IF EXISTS contact_emails;
