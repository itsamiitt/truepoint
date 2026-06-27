CREATE TABLE IF NOT EXISTS "plan_templates" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"seat_limit" integer NOT NULL,
	"workspace_limit" integer,
	"monthly_credit_grant" integer,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_templates_key_unique" UNIQUE("key")
);
