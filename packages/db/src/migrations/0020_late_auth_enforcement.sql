ALTER TABLE "tenant_auth_policies" ADD COLUMN IF NOT EXISTS "idle_timeout_seconds" integer;--> statement-breakpoint
ALTER TABLE "tenant_auth_policies" ADD COLUMN IF NOT EXISTS "enforcement_enabled" boolean DEFAULT false NOT NULL;
