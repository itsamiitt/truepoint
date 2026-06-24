DROP INDEX IF EXISTS "uniq_lists_ws_name";--> statement-breakpoint
ALTER TABLE "list_members" ADD COLUMN "added_via" varchar(20) DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "list_members" ADD COLUMN "source_import_id" uuid;--> statement-breakpoint
ALTER TABLE "lists" ADD COLUMN "list_kind" varchar(20) DEFAULT 'static' NOT NULL;--> statement-breakpoint
ALTER TABLE "lists" ADD COLUMN "color" varchar(30);--> statement-breakpoint
ALTER TABLE "lists" ADD COLUMN "icon" varchar(40);--> statement-breakpoint
ALTER TABLE "lists" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "lists" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "lists" ADD COLUMN "source" varchar(40);--> statement-breakpoint
ALTER TABLE "lists" ADD COLUMN "saved_search_id" uuid;--> statement-breakpoint
ALTER TABLE "lists" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lists" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "list_members" ADD CONSTRAINT "list_members_source_import_id_source_imports_id_fk" FOREIGN KEY ("source_import_id") REFERENCES "public"."source_imports"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lists" ADD CONSTRAINT "lists_saved_search_id_saved_searches_id_fk" FOREIGN KEY ("saved_search_id") REFERENCES "public"."saved_searches"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_lists_ws_name" ON "lists" USING btree ("workspace_id","name") WHERE "lists"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "list_members" ADD CONSTRAINT "list_members_added_via_enum" CHECK ("list_members"."added_via" IN ('search','import','manual','api'));--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_list_kind_enum" CHECK ("lists"."list_kind" IN ('static','dynamic'));