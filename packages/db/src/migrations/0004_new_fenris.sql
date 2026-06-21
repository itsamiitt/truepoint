CREATE TABLE IF NOT EXISTS "list_members" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"list_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"added_by_user_id" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lists" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "technologies" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "funding_stage" varchar(50);--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "company_stage" varchar(50);--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "founded_year" integer;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "duplicate_of_contact_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "list_members" ADD CONSTRAINT "list_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "list_members" ADD CONSTRAINT "list_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "list_members" ADD CONSTRAINT "list_members_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "list_members" ADD CONSTRAINT "list_members_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "list_members" ADD CONSTRAINT "list_members_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lists" ADD CONSTRAINT "lists_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lists" ADD CONSTRAINT "lists_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lists" ADD CONSTRAINT "lists_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_list_members_list_contact" ON "list_members" USING btree ("list_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_lists_ws_name" ON "lists" USING btree ("workspace_id","name");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contacts" ADD CONSTRAINT "contacts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contacts" ADD CONSTRAINT "contacts_duplicate_of_contact_id_contacts_id_fk" FOREIGN KEY ("duplicate_of_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_accounts_technologies_gin" ON "accounts" USING gin ("technologies");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contacts_ws_owner" ON "contacts" USING btree ("workspace_id","owner_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contacts_duplicate_of" ON "contacts" USING btree ("duplicate_of_contact_id") WHERE "contacts"."duplicate_of_contact_id" IS NOT NULL;--> statement-breakpoint
-- Backfill the soft owner from the existing first-reveal owner, else the earliest importer (best-effort:
-- runs as the migration role; effective on superuser-owned/fresh DBs. On managed Postgres where the owner is
-- non-superuser and RLS is already active, unmatched rows simply stay unassigned — a safe default the UI
-- handles, and new contacts get an owner at import/assign time). Idempotent (only fills NULLs).
UPDATE "contacts" c SET "owner_user_id" = COALESCE(
  c."revealed_by_user_id",
  (SELECT si."imported_by_user_id" FROM "source_imports" si
    WHERE si."contact_id" = c."id" AND si."imported_by_user_id" IS NOT NULL
    ORDER BY si."imported_at" ASC LIMIT 1)
) WHERE c."owner_user_id" IS NULL;