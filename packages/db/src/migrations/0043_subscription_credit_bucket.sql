ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "subscription_credit_balance" integer DEFAULT 0 NOT NULL;
