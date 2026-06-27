CREATE TABLE IF NOT EXISTS "jit_elevations" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"target_tenant_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	"approved_by_user_id" uuid,
	"ip" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jit_elevations_staff_action_status_idx" ON "jit_elevations" USING btree ("staff_user_id","action","status");