CREATE TABLE IF NOT EXISTS "provider_configs" (
	"provider" varchar(50) PRIMARY KEY NOT NULL,
	"label" varchar(100) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"rate_limit_per_min" integer,
	"monthly_budget_cents" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
