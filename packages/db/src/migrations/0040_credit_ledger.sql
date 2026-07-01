CREATE TABLE IF NOT EXISTS "credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid,
	"entry_type" varchar(20) NOT NULL,
	"delta" integer NOT NULL,
	"balance_after" integer,
	"idempotency_key" varchar(255) NOT NULL,
	"reveal_id" uuid,
	"purchase_id" uuid,
	"actor_user_id" uuid,
	"reason" varchar(255),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_ledger_entry_type_enum" CHECK ("credit_ledger"."entry_type" IN ('grant','spend','credit_back','adjustment','lease','settle','release')),
	CONSTRAINT "credit_ledger_delta_sign" CHECK (
		("credit_ledger"."entry_type" IN ('grant','credit_back','release') AND "credit_ledger"."delta" >= 0)
		OR ("credit_ledger"."entry_type" IN ('spend','lease','settle') AND "credit_ledger"."delta" <= 0)
		OR ("credit_ledger"."entry_type" = 'adjustment')
	)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_reveal_id_contact_reveals_id_fk" FOREIGN KEY ("reveal_id") REFERENCES "public"."contact_reveals"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_credit_ledger_tenant_idem" ON "credit_ledger" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_credit_ledger_tenant_created" ON "credit_ledger" USING btree ("tenant_id","created_at" DESC);
