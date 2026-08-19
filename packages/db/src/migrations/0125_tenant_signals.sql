-- 0125_tenant_signals.sql — the Layer-1 projection of master_signals [S-13][S-09][A-01]
-- (hand-authored, additive-only; docs/planning/market-intelligence/06-architecture.md MI-S6).
--
-- One row per (workspace, master signal), written only by the signal_fanout sweep. Layer 0 stays the
-- source of truth; this is the DELIVERED copy the feed, scoring and alerts read under RLS. No FK to
-- master_signals (partitioned parent in a different trust layer) — uniq_tenant_signals_ws_signal is the
-- fan-out's idempotency wall instead. RLS + grants land via rls/tenantSignals.sql on the same migrate.

CREATE TABLE IF NOT EXISTS "tenant_signals" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "account_id" uuid REFERENCES "accounts"("id") ON DELETE CASCADE,
  "contact_id" uuid REFERENCES "contacts"("id") ON DELETE CASCADE,
  "master_signal_id" uuid NOT NULL,
  "type_code" varchar(50) NOT NULL,
  "family" varchar(20) NOT NULL,
  "headline" varchar(300),
  "amount_minor" bigint,
  "currency" varchar(3),
  "observed_at" timestamptz NOT NULL,
  "delivered_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_signals_family_enum"
    CHECK ("family" IN ('hiring','funding','tech_change','leadership','filing','other')),
  CONSTRAINT "tenant_signals_subject_present"
    CHECK ("account_id" IS NOT NULL OR "contact_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_tenant_signals_ws_signal"
  ON "tenant_signals" ("workspace_id", "master_signal_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tenant_signals_ws_observed"
  ON "tenant_signals" ("workspace_id", "observed_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tenant_signals_ws_account"
  ON "tenant_signals" ("workspace_id", "account_id", "observed_at" DESC);
