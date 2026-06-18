CREATE TABLE IF NOT EXISTS "feature_flags" (
	"key" varchar(100) PRIMARY KEY NOT NULL,
	"description" varchar(500),
	"global_enabled" boolean DEFAULT false NOT NULL,
	"default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_feature_flags" (
	"flag_key" varchar(100) NOT NULL,
	"tenant_id" uuid NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_feature_flags_flag_key_tenant_id_pk" PRIMARY KEY("flag_key","tenant_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_feature_flags" ADD CONSTRAINT "tenant_feature_flags_flag_key_feature_flags_key_fk" FOREIGN KEY ("flag_key") REFERENCES "public"."feature_flags"("key") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_feature_flags" ADD CONSTRAINT "tenant_feature_flags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
