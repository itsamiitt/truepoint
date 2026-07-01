ALTER TABLE "credit_packs" ADD COLUMN IF NOT EXISTS "stripe_price_id" text;--> statement-breakpoint
ALTER TABLE "plan_templates" ADD COLUMN IF NOT EXISTS "stripe_price_id" text;
