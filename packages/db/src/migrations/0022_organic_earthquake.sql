CREATE TABLE IF NOT EXISTS "support_notes" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"ticket_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_notes_tenant_idx" ON "support_notes" USING btree ("tenant_id","id");