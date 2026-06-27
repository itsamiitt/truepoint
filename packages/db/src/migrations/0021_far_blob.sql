CREATE TABLE IF NOT EXISTS "email_message" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"mailbox_integration_id" uuid,
	"contact_id" uuid,
	"outreach_log_id" uuid,
	"direction" varchar(10) NOT NULL,
	"provider_message_id" varchar(255),
	"rfc822_message_id" varchar(998),
	"in_reply_to" varchar(998),
	"reference_ids" text[],
	"subject" varchar(255),
	"snippet" varchar(280),
	"from_addr" "citext" NOT NULL,
	"to_addrs" text[],
	"body_enc" "bytea",
	"is_auto_reply" boolean DEFAULT false NOT NULL,
	"classification" varchar(20) DEFAULT 'unknown' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_message_direction_enum" CHECK ("email_message"."direction" IN ('inbound','outbound')),
	CONSTRAINT "email_message_classification_enum" CHECK ("email_message"."classification" IN ('human','auto_reply','ooo','bounce','unknown'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_thread" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid,
	"owner_user_id" uuid,
	"mailbox_integration_id" uuid,
	"sequence_id" uuid,
	"provider_thread_id" varchar(255),
	"subject_normalized" varchar(255),
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"assignee_user_id" uuid,
	"last_message_at" timestamp with time zone,
	"message_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_thread_status_enum" CHECK ("email_thread"."status" IN ('open','snoozed','done'))
);
--> statement-breakpoint
ALTER TABLE "email_event" DROP CONSTRAINT "email_event_type_enum";--> statement-breakpoint
ALTER TABLE "outreach_log" ADD COLUMN "last_reply_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_message" ADD CONSTRAINT "email_message_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_message" ADD CONSTRAINT "email_message_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_message" ADD CONSTRAINT "email_message_thread_id_email_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."email_thread"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_message" ADD CONSTRAINT "email_message_mailbox_integration_id_mailbox_integration_id_fk" FOREIGN KEY ("mailbox_integration_id") REFERENCES "public"."mailbox_integration"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_message" ADD CONSTRAINT "email_message_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_message" ADD CONSTRAINT "email_message_outreach_log_id_outreach_log_id_fk" FOREIGN KEY ("outreach_log_id") REFERENCES "public"."outreach_log"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_thread" ADD CONSTRAINT "email_thread_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_thread" ADD CONSTRAINT "email_thread_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_thread" ADD CONSTRAINT "email_thread_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_thread" ADD CONSTRAINT "email_thread_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_thread" ADD CONSTRAINT "email_thread_mailbox_integration_id_mailbox_integration_id_fk" FOREIGN KEY ("mailbox_integration_id") REFERENCES "public"."mailbox_integration"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_thread" ADD CONSTRAINT "email_thread_sequence_id_outreach_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."outreach_sequences"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_thread" ADD CONSTRAINT "email_thread_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_email_message_thread" ON "email_message" USING btree ("thread_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_email_message_ws_occurred" ON "email_message" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_email_message_rfc822" ON "email_message" USING btree ("workspace_id","rfc822_message_id") WHERE "email_message"."rfc822_message_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_email_message_provider" ON "email_message" USING btree ("mailbox_integration_id","provider_message_id") WHERE "email_message"."provider_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_email_thread_ws_last_message" ON "email_thread" USING btree ("workspace_id","last_message_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_email_thread_ws_owner" ON "email_thread" USING btree ("workspace_id","owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_email_thread_provider" ON "email_thread" USING btree ("mailbox_integration_id","provider_thread_id") WHERE "email_thread"."provider_thread_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "email_event" ADD CONSTRAINT "email_event_type_enum" CHECK ("email_event"."event_type" IN ('delivery','open','click','bounce','complaint','unsubscribe','reply','auto_reply'));