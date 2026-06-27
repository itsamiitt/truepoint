CREATE TABLE IF NOT EXISTS "account_holds" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"placed_by_user_id" uuid NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by_user_id" uuid
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_holds_tenant_idx" ON "account_holds" USING btree ("tenant_id","id");