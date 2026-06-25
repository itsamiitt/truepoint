CREATE TABLE IF NOT EXISTS "email_event" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"outreach_log_id" uuid,
	"contact_id" uuid,
	"message_id" varchar(255),
	"event_type" varchar(20) NOT NULL,
	"provider_event_id" varchar(255),
	"is_mpp_suspected" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_event_type_enum" CHECK ("email_event"."event_type" IN ('delivery','open','click','bounce','complaint','unsubscribe'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mailbox_integration" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"provider" varchar(20) NOT NULL,
	"address" "citext" NOT NULL,
	"sending_domain_id" uuid,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"oauth_token_enc" "bytea",
	"smtp_secret_enc" "bytea",
	"last_error" varchar(500),
	"connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_integration_provider_enum" CHECK ("mailbox_integration"."provider" IN ('google','microsoft','smtp','ses')),
	CONSTRAINT "mailbox_integration_status_enum" CHECK ("mailbox_integration"."status" IN ('pending','connected','error','disconnected'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sending_domain" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"domain" "citext" NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"spf_state" varchar(20) DEFAULT 'unverified' NOT NULL,
	"dkim_state" varchar(20) DEFAULT 'unverified' NOT NULL,
	"dmarc_state" varchar(20) DEFAULT 'unverified' NOT NULL,
	"dkim_selector" varchar(100),
	"dkim_public_key" varchar(2000),
	"tracking_cname" varchar(255),
	"tracking_cname_state" varchar(20) DEFAULT 'unverified' NOT NULL,
	"region" varchar(2) DEFAULT 'US' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sending_domain_status_enum" CHECK ("sending_domain"."status" IN ('pending','verifying','verified','failed')),
	CONSTRAINT "sending_domain_auth_state_enum" CHECK ("sending_domain"."spf_state" IN ('unverified','pass','fail')
        AND "sending_domain"."dkim_state" IN ('unverified','pass','fail')
        AND "sending_domain"."dmarc_state" IN ('unverified','pass','fail'))
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "email_send_quota" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "email_send_used" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "email_send_period_start" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_event" ADD CONSTRAINT "email_event_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_event" ADD CONSTRAINT "email_event_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_event" ADD CONSTRAINT "email_event_outreach_log_id_outreach_log_id_fk" FOREIGN KEY ("outreach_log_id") REFERENCES "public"."outreach_log"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_event" ADD CONSTRAINT "email_event_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mailbox_integration" ADD CONSTRAINT "mailbox_integration_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mailbox_integration" ADD CONSTRAINT "mailbox_integration_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mailbox_integration" ADD CONSTRAINT "mailbox_integration_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mailbox_integration" ADD CONSTRAINT "mailbox_integration_sending_domain_id_sending_domain_id_fk" FOREIGN KEY ("sending_domain_id") REFERENCES "public"."sending_domain"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sending_domain" ADD CONSTRAINT "sending_domain_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_email_event_provider_event_id" ON "email_event" USING btree ("provider_event_id") WHERE "email_event"."provider_event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_email_event_ws_occurred" ON "email_event" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_email_event_log" ON "email_event" USING btree ("outreach_log_id") WHERE "email_event"."outreach_log_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_mailbox_integration_ws_address" ON "mailbox_integration" USING btree ("workspace_id","address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mailbox_integration_ws" ON "mailbox_integration" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_sending_domain_domain" ON "sending_domain" USING btree ("domain");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sending_domain_tenant" ON "sending_domain" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_email_send_quota_nonneg" CHECK ("tenants"."email_send_used" >= 0 AND ("tenants"."email_send_quota" IS NULL OR "tenants"."email_send_used" <= "tenants"."email_send_quota"));