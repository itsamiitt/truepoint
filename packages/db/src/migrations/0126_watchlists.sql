-- 0126_watchlists.sql — watchlists + members + per-user signal subscriptions [S-13][S-14]
-- (hand-authored, additive-only; docs/planning/market-intelligence/04 MI-3 / 06 MI-S5).
--
-- The opt-in layer over tenant_signals (0125): the feed is browseable; a NOTIFICATION requires a
-- subscription naming the family. Families share the closed 0103 vocabulary — deliberately NO 'intent'
-- (X-04). RLS + grants land via rls/watchlists.sql on the same migrate.

CREATE TABLE IF NOT EXISTS "watchlists" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" varchar(120) NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_watchlists_ws_name" ON "watchlists" ("workspace_id", "name");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "watchlist_members" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "watchlist_id" uuid NOT NULL REFERENCES "watchlists"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "added_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "added_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_watchlist_members" ON "watchlist_members" ("watchlist_id", "account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_watchlist_members_ws_account" ON "watchlist_members" ("workspace_id", "account_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signal_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "watchlist_id" uuid NOT NULL REFERENCES "watchlists"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "families" text[] NOT NULL DEFAULT '{}'::text[],
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "signal_subscriptions_families_enum"
    CHECK ("families" <@ ARRAY['hiring','funding','tech_change','leadership','filing','other']::text[])
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_signal_subscriptions" ON "signal_subscriptions" ("watchlist_id", "user_id");
