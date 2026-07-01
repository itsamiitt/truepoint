CREATE TABLE IF NOT EXISTS "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_template_key" text NOT NULL,
	"stripe_subscription_id" varchar(255),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"term" varchar(20) DEFAULT 'month_to_month' NOT NULL,
	"auto_renew" boolean DEFAULT false NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id"),
	CONSTRAINT "subscriptions_status_enum" CHECK (status IN ('trialing','active','past_due','canceled','paused','incomplete')),
	CONSTRAINT "subscriptions_term_enum" CHECK (term IN ('month_to_month','annual'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_cycles" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"grant_credits" integer DEFAULT 0 NOT NULL,
	"granted_at" timestamp with time zone,
	"grant_ledger_id" uuid,
	"rollover_credits" integer DEFAULT 0 NOT NULL,
	"invoice_id" uuid,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_cycles_status_enum" CHECK (status IN ('open','granted','closed','skipped')),
	CONSTRAINT "billing_cycles_grant_nonneg" CHECK (grant_credits >= 0 AND rollover_credits >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_cycles" ADD CONSTRAINT "billing_cycles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_cycles" ADD CONSTRAINT "billing_cycles_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_cycles" ADD CONSTRAINT "billing_cycles_grant_ledger_id_credit_ledger_id_fk" FOREIGN KEY ("grant_ledger_id") REFERENCES "public"."credit_ledger"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_subscriptions_tenant_active" ON "subscriptions" USING btree ("tenant_id") WHERE status IN ('trialing','active','past_due','paused');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_subscriptions_tenant" ON "subscriptions" USING btree ("tenant_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_subscriptions_renewal_due" ON "subscriptions" USING btree ("current_period_end") WHERE auto_renew = true AND status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_billing_cycles_sub_period" ON "billing_cycles" USING btree ("subscription_id","period_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_cycles_tenant" ON "billing_cycles" USING btree ("tenant_id","period_start" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_cycles_pending_grant" ON "billing_cycles" USING btree ("period_start") WHERE granted_at IS NULL AND status = 'open';
