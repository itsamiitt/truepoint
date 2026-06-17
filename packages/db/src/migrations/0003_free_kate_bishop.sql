CREATE TABLE IF NOT EXISTS "custom_field_definitions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity" varchar(20) NOT NULL,
	"key" varchar(64) NOT NULL,
	"label" varchar(120) NOT NULL,
	"field_type" varchar(20) NOT NULL,
	"options" jsonb,
	"required" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"ordering" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_field_defs_entity_enum" CHECK ("custom_field_definitions"."entity" IN ('contact','account')),
	CONSTRAINT "custom_field_defs_type_enum" CHECK ("custom_field_definitions"."field_type" IN ('text','number','date','select','boolean','url')),
	CONSTRAINT "custom_field_defs_options_shape" CHECK (("custom_field_definitions"."field_type" = 'select' AND "custom_field_definitions"."options" IS NOT NULL AND jsonb_array_length("custom_field_definitions"."options") > 0)
          OR ("custom_field_definitions"."field_type" <> 'select' AND "custom_field_definitions"."options" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_custom_field_defs_ws_entity_key" ON "custom_field_definitions" USING btree ("workspace_id","entity","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_accounts_custom_fields_gin" ON "accounts" USING gin ("custom_fields");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contacts_custom_fields_gin" ON "contacts" USING gin ("custom_fields");