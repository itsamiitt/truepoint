CREATE TABLE IF NOT EXISTS "auth_allowed_origins" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"scope" varchar(12) NOT NULL,
	"tenant_id" uuid,
	"origin" varchar(255) NOT NULL,
	"kind" varchar(20) DEFAULT 'callback' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_allowed_origins_scope_enum" CHECK ("auth_allowed_origins"."scope" IN ('platform','org')),
	CONSTRAINT "auth_allowed_origins_scope_consistency" CHECK (
		("auth_allowed_origins"."scope" = 'platform' AND "auth_allowed_origins"."tenant_id" IS NULL)
		OR ("auth_allowed_origins"."scope" = 'org' AND "auth_allowed_origins"."tenant_id" IS NOT NULL)
	)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth_allowed_origins" ADD CONSTRAINT "auth_allowed_origins_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth_allowed_origins" ADD CONSTRAINT "auth_allowed_origins_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_auth_allowed_origin" ON "auth_allowed_origins" ("scope","tenant_id","origin") NULLS NOT DISTINCT;
