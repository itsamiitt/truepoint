CREATE INDEX IF NOT EXISTS "idx_accounts_ws_industry" ON "accounts" USING btree ("workspace_id","industry");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_accounts_ws_employee_count" ON "accounts" USING btree ("workspace_id","employee_count");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_accounts_ws_name" ON "accounts" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_accounts_ws_created_at" ON "accounts" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contacts_ws_account" ON "contacts" USING btree ("workspace_id","account_id") WHERE "contacts"."account_id" IS NOT NULL;