CREATE TABLE IF NOT EXISTS "oauth_connect_state" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(20) NOT NULL,
	"state_token" varchar(80) NOT NULL,
	"pkce_verifier_enc" "bytea" NOT NULL,
	"redirect_after" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "oauth_connect_state_provider_enum" CHECK ("oauth_connect_state"."provider" IN ('google','microsoft'))
);
--> statement-breakpoint
ALTER TABLE "mailbox_integration" ADD COLUMN "oauth_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailbox_integration" ADD COLUMN "oauth_scopes" text[];--> statement-breakpoint
ALTER TABLE "mailbox_integration" ADD COLUMN "provider_account_id" varchar(255);--> statement-breakpoint
ALTER TABLE "mailbox_integration" ADD COLUMN "reauth_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mailbox_integration" ADD COLUMN "reauth_reason" varchar(120);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_connect_state" ADD CONSTRAINT "oauth_connect_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_connect_state" ADD CONSTRAINT "oauth_connect_state_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_connect_state" ADD CONSTRAINT "oauth_connect_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_oauth_connect_state_token" ON "oauth_connect_state" USING btree ("state_token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_oauth_connect_state_tenant" ON "oauth_connect_state" USING btree ("tenant_id","created_at");