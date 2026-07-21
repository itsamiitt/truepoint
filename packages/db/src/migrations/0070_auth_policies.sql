CREATE TABLE IF NOT EXISTS "auth_policies" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"scope" varchar(12) NOT NULL,
	"tenant_id" uuid,
	"workspace_id" uuid,
	"key" varchar(64) NOT NULL,
	"value" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_policies_scope_enum" CHECK ("auth_policies"."scope" IN ('platform','org','workspace')),
	CONSTRAINT "auth_policies_scope_consistency" CHECK (
		("auth_policies"."scope" = 'platform' AND "auth_policies"."tenant_id" IS NULL AND "auth_policies"."workspace_id" IS NULL)
		OR ("auth_policies"."scope" = 'org' AND "auth_policies"."tenant_id" IS NOT NULL AND "auth_policies"."workspace_id" IS NULL)
		OR ("auth_policies"."scope" = 'workspace' AND "auth_policies"."tenant_id" IS NOT NULL AND "auth_policies"."workspace_id" IS NOT NULL)
	)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth_policies" ADD CONSTRAINT "auth_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth_policies" ADD CONSTRAINT "auth_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth_policies" ADD CONSTRAINT "auth_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_auth_policy_scope_key" ON "auth_policies" ("scope","tenant_id","workspace_id","key") NULLS NOT DISTINCT;
