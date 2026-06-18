ALTER TABLE "sales_nav_links" ADD COLUMN "sales_nav_lead_id" varchar(255);--> statement-breakpoint
ALTER TABLE "sales_nav_links" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "sales_nav_links" ADD COLUMN "labels" text;--> statement-breakpoint
ALTER TABLE "sales_nav_links" ADD COLUMN "captured_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_sales_nav_links_ws_lead_id" ON "sales_nav_links" USING btree ("workspace_id","sales_nav_lead_id") WHERE "sales_nav_links"."sales_nav_lead_id" IS NOT NULL;