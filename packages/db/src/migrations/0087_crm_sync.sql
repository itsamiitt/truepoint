CREATE TABLE "crm_connections" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"provider" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"sync_mode" varchar(20) DEFAULT 'shadow' NOT NULL,
	"environment" varchar(20) DEFAULT 'production' NOT NULL,
	"external_account_id" varchar(255),
	"instance_url" varchar(500),
	"oauth_token_enc" "bytea",
	"token_expires_at" timestamp with time zone,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"next_poll_at" timestamp with time zone,
	"last_error" varchar(500),
	"last_refresh_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_connections_provider_enum" CHECK ("crm_connections"."provider" IN ('salesforce','hubspot')),
	CONSTRAINT "crm_connections_status_enum" CHECK ("crm_connections"."status" IN ('pending','connected','error','paused','disconnected')),
	CONSTRAINT "crm_connections_mode_enum" CHECK ("crm_connections"."sync_mode" IN ('disabled','shadow','enforce')),
	CONSTRAINT "crm_connections_env_enum" CHECK ("crm_connections"."environment" IN ('production','sandbox'))
);
--> statement-breakpoint
CREATE TABLE "crm_field_mappings" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"object_type" varchar(20) NOT NULL,
	"tp_field" varchar(100) NOT NULL,
	"crm_field" varchar(255) NOT NULL,
	"direction" varchar(20) DEFAULT 'inbound' NOT NULL,
	"authority" varchar(20) DEFAULT 'crm' NOT NULL,
	"conf_threshold" numeric(4, 3),
	"transform" varchar(40) DEFAULT 'passthrough' NOT NULL,
	"transform_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"is_dedup_key" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_field_mappings_object_type_enum" CHECK ("crm_field_mappings"."object_type" IN ('contact','account','lead','deal')),
	CONSTRAINT "crm_field_mappings_direction_enum" CHECK ("crm_field_mappings"."direction" IN ('inbound','outbound','bidirectional','disabled')),
	CONSTRAINT "crm_field_mappings_authority_enum" CHECK ("crm_field_mappings"."authority" IN ('crm','truepoint')),
	CONSTRAINT "crm_field_mappings_transform_enum" CHECK ("crm_field_mappings"."transform" IN ('passthrough','phone_e164','lowercase','seniority_map','date_iso','picklist_map'))
);
--> statement-breakpoint
CREATE TABLE "crm_inbound_events" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" varchar(20) NOT NULL,
	"object_type" varchar(20) NOT NULL,
	"crm_object_type" varchar(40) NOT NULL,
	"crm_record_id" varchar(255) NOT NULL,
	"provider_event_id" varchar(255) NOT NULL,
	"event_type" varchar(60),
	"source_tag" varchar(120),
	"process_status" varchar(20) DEFAULT 'pending' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "crm_inbound_events_provider_enum" CHECK ("crm_inbound_events"."provider" IN ('salesforce','hubspot')),
	CONSTRAINT "crm_inbound_events_object_type_enum" CHECK ("crm_inbound_events"."object_type" IN ('contact','account','lead','deal')),
	CONSTRAINT "crm_inbound_events_process_status_enum" CHECK ("crm_inbound_events"."process_status" IN ('pending','processed','skipped','failed'))
);
--> statement-breakpoint
CREATE TABLE "crm_oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"provider" varchar(20) NOT NULL,
	"state" varchar(255) NOT NULL,
	"code_verifier_enc" "bytea",
	"redirect_uri" varchar(500),
	"environment" varchar(20) DEFAULT 'production' NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_oauth_states_provider_enum" CHECK ("crm_oauth_states"."provider" IN ('salesforce','hubspot')),
	CONSTRAINT "crm_oauth_states_env_enum" CHECK ("crm_oauth_states"."environment" IN ('production','sandbox'))
);
--> statement-breakpoint
CREATE TABLE "crm_record_links" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"tp_entity_type" varchar(20) NOT NULL,
	"contact_id" uuid,
	"account_id" uuid,
	"crm_object_type" varchar(40) NOT NULL,
	"crm_record_id" varchar(255) NOT NULL,
	"external_key" varchar(255),
	"last_synced_hash" "bytea",
	"last_inbound_modstamp" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"link_status" varchar(20) DEFAULT 'linked' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_record_links_type_enum" CHECK ("crm_record_links"."tp_entity_type" IN ('contact','account')),
	CONSTRAINT "crm_record_links_status_enum" CHECK ("crm_record_links"."link_status" IN ('linked','ambiguous','broken')),
	CONSTRAINT "crm_record_links_exactly_one" CHECK (num_nonnulls("crm_record_links"."contact_id", "crm_record_links"."account_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "crm_sync_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"record_link_id" uuid,
	"object_type" varchar(20) NOT NULL,
	"field" varchar(100) NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"tp_value" text,
	"crm_value" text,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_sync_conflicts_object_type_enum" CHECK ("crm_sync_conflicts"."object_type" IN ('contact','account','lead','deal')),
	CONSTRAINT "crm_sync_conflicts_status_enum" CHECK ("crm_sync_conflicts"."status" IN ('open','resolved','ignored'))
);
--> statement-breakpoint
CREATE TABLE "crm_sync_dead_letter" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"run_id" uuid,
	"queue" varchar(40) NOT NULL,
	"direction" varchar(20),
	"object_type" varchar(20),
	"crm_object_type" varchar(40),
	"crm_record_id" varchar(255),
	"tp_entity_id" uuid,
	"error_class" varchar(30) NOT NULL,
	"error_detail" varchar(1000),
	"attempts" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_sync_dead_letter_error_class_enum" CHECK ("crm_sync_dead_letter"."error_class" IN ('rate_limited','auth','validation','conflict_unresolved','transform','not_found','provider_5xx','ssrf_blocked','suppressed','unknown')),
	CONSTRAINT "crm_sync_dead_letter_status_enum" CHECK ("crm_sync_dead_letter"."status" IN ('open','retrying','resolved','ignored')),
	CONSTRAINT "crm_sync_dead_letter_direction_enum" CHECK ("crm_sync_dead_letter"."direction" IS NULL OR "crm_sync_dead_letter"."direction" IN ('inbound','outbound')),
	CONSTRAINT "crm_sync_dead_letter_object_type_enum" CHECK ("crm_sync_dead_letter"."object_type" IS NULL OR "crm_sync_dead_letter"."object_type" IN ('contact','account','lead','deal'))
);
--> statement-breakpoint
CREATE TABLE "crm_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" varchar(20) NOT NULL,
	"object_type" varchar(20) NOT NULL,
	"direction" varchar(20) NOT NULL,
	"trigger" varchar(20) NOT NULL,
	"mode" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'running' NOT NULL,
	"records_seen" integer DEFAULT 0 NOT NULL,
	"records_created" integer DEFAULT 0 NOT NULL,
	"records_updated" integer DEFAULT 0 NOT NULL,
	"records_matched" integer DEFAULT 0 NOT NULL,
	"records_skipped" integer DEFAULT 0 NOT NULL,
	"records_conflicted" integer DEFAULT 0 NOT NULL,
	"records_failed" integer DEFAULT 0 NOT NULL,
	"api_calls" integer DEFAULT 0 NOT NULL,
	"rate_limited_ct" integer DEFAULT 0 NOT NULL,
	"rate_limit_remaining" integer,
	"watermark_before" timestamp with time zone,
	"watermark_after" timestamp with time zone,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"sync_run_id" uuid,
	"failed_reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_sync_runs_provider_enum" CHECK ("crm_sync_runs"."provider" IN ('salesforce','hubspot')),
	CONSTRAINT "crm_sync_runs_object_type_enum" CHECK ("crm_sync_runs"."object_type" IN ('contact','account','lead','deal')),
	CONSTRAINT "crm_sync_runs_direction_enum" CHECK ("crm_sync_runs"."direction" IN ('inbound','outbound')),
	CONSTRAINT "crm_sync_runs_trigger_enum" CHECK ("crm_sync_runs"."trigger" IN ('backfill','scheduled','webhook','manual','replay','dsar')),
	CONSTRAINT "crm_sync_runs_mode_enum" CHECK ("crm_sync_runs"."mode" IN ('disabled','shadow','enforce')),
	CONSTRAINT "crm_sync_runs_status_enum" CHECK ("crm_sync_runs"."status" IN ('running','completed','partial','failed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "crm_sync_state" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"object_type" varchar(20) NOT NULL,
	"direction" varchar(20) NOT NULL,
	"watermark" timestamp with time zone,
	"replay_id" varchar(255),
	"backfill_status" varchar(20) DEFAULT 'pending' NOT NULL,
	"backfill_cursor" varchar(512),
	"last_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_sync_state_object_type_enum" CHECK ("crm_sync_state"."object_type" IN ('contact','account','lead','deal')),
	CONSTRAINT "crm_sync_state_direction_enum" CHECK ("crm_sync_state"."direction" IN ('inbound','outbound')),
	CONSTRAINT "crm_sync_state_backfill_status_enum" CHECK ("crm_sync_state"."backfill_status" IN ('pending','running','completed'))
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_enum";--> statement-breakpoint
-- REMOVED (hand-edit): drizzle-kit also emitted
--   ALTER TABLE "activities" ADD CONSTRAINT "activities_id_occurred_at_pk" PRIMARY KEY("id","occurred_at");
-- That constraint ALREADY EXISTS. 0085_partition_activities.sql is hand-authored SQL that creates the
-- partitioned table with `PRIMARY KEY (id, occurred_at)` inline (0085:65); drizzle never snapshotted it, so
-- generate saw the schema declare a composite PK the snapshot lacked and tried to add it. Executing it fails
-- with "multiple primary keys for table activities are not allowed" and takes the whole migration down.
-- The 0087 snapshot written alongside this file now records the PK, so the drift does not recur.
-- Lesson: after any hand-authored DDL migration, read what the NEXT generate emits outside its own feature.
ALTER TABLE "crm_connections" ADD CONSTRAINT "crm_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_connections" ADD CONSTRAINT "crm_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_connections" ADD CONSTRAINT "crm_connections_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_field_mappings" ADD CONSTRAINT "crm_field_mappings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_field_mappings" ADD CONSTRAINT "crm_field_mappings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_field_mappings" ADD CONSTRAINT "crm_field_mappings_connection_id_crm_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."crm_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_inbound_events" ADD CONSTRAINT "crm_inbound_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_inbound_events" ADD CONSTRAINT "crm_inbound_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_inbound_events" ADD CONSTRAINT "crm_inbound_events_connection_id_crm_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."crm_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_oauth_states" ADD CONSTRAINT "crm_oauth_states_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_oauth_states" ADD CONSTRAINT "crm_oauth_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_oauth_states" ADD CONSTRAINT "crm_oauth_states_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_record_links" ADD CONSTRAINT "crm_record_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_record_links" ADD CONSTRAINT "crm_record_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_record_links" ADD CONSTRAINT "crm_record_links_connection_id_crm_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."crm_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_record_links" ADD CONSTRAINT "crm_record_links_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_record_links" ADD CONSTRAINT "crm_record_links_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_conflicts" ADD CONSTRAINT "crm_sync_conflicts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_conflicts" ADD CONSTRAINT "crm_sync_conflicts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_conflicts" ADD CONSTRAINT "crm_sync_conflicts_connection_id_crm_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."crm_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_conflicts" ADD CONSTRAINT "crm_sync_conflicts_record_link_id_crm_record_links_id_fk" FOREIGN KEY ("record_link_id") REFERENCES "public"."crm_record_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_conflicts" ADD CONSTRAINT "crm_sync_conflicts_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_dead_letter" ADD CONSTRAINT "crm_sync_dead_letter_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_dead_letter" ADD CONSTRAINT "crm_sync_dead_letter_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_dead_letter" ADD CONSTRAINT "crm_sync_dead_letter_connection_id_crm_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."crm_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_dead_letter" ADD CONSTRAINT "crm_sync_dead_letter_run_id_crm_sync_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."crm_sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_runs" ADD CONSTRAINT "crm_sync_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_runs" ADD CONSTRAINT "crm_sync_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_runs" ADD CONSTRAINT "crm_sync_runs_connection_id_crm_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."crm_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_state" ADD CONSTRAINT "crm_sync_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_state" ADD CONSTRAINT "crm_sync_state_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_state" ADD CONSTRAINT "crm_sync_state_connection_id_crm_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."crm_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_state" ADD CONSTRAINT "crm_sync_state_last_run_id_crm_sync_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."crm_sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_crm_connections_ws_provider_account" ON "crm_connections" USING btree ("workspace_id","provider","external_account_id") WHERE "crm_connections"."external_account_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_crm_connections_sweep" ON "crm_connections" USING btree ("status","next_poll_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_crm_field_mappings" ON "crm_field_mappings" USING btree ("connection_id","object_type","tp_field","crm_field");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_crm_inbound_events_provider_event" ON "crm_inbound_events" USING btree ("connection_id","provider_event_id");--> statement-breakpoint
CREATE INDEX "idx_crm_inbound_events_unprocessed" ON "crm_inbound_events" USING btree ("connection_id","process_status","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_crm_oauth_states_state" ON "crm_oauth_states" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_crm_record_links_crm" ON "crm_record_links" USING btree ("connection_id","crm_object_type","crm_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_crm_record_links_contact" ON "crm_record_links" USING btree ("connection_id","contact_id") WHERE "crm_record_links"."contact_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_crm_record_links_account" ON "crm_record_links" USING btree ("connection_id","account_id") WHERE "crm_record_links"."account_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_crm_record_links_recon" ON "crm_record_links" USING btree ("connection_id","last_inbound_modstamp");--> statement-breakpoint
CREATE INDEX "idx_crm_sync_conflicts_open" ON "crm_sync_conflicts" USING btree ("workspace_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_crm_sync_dead_letter_open" ON "crm_sync_dead_letter" USING btree ("workspace_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_crm_sync_runs_ws_created" ON "crm_sync_runs" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_crm_sync_runs_conn_started" ON "crm_sync_runs" USING btree ("connection_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_crm_sync_state_stream" ON "crm_sync_state" USING btree ("connection_id","object_type","direction");--> statement-breakpoint
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
        'channel_added','channel_promoted','channel_deleted','channel_primary_demoted',
        'contact.merge',
        'crm.connect','crm.disconnect','crm.sync','crm.mapping.update','crm.erase'
      ));