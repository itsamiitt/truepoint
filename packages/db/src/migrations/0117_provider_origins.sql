-- 0117_provider_origins.sql — the data-source ORIGIN fleet for external providers [S-09][S-04][S-08][A-01]
-- (hand-authored, additive-only; docs/planning/linkedin-source-ingestion/ §origins).
--
-- One provider is served by many interchangeable origins (data.truepoint.in, expo.truepoint.in, …), each
-- exposing the same POST contract; the fetch layer walks them as a FAILOVER CHAIN in priority order.
-- api_key_enc is AES-GCM ciphertext (the crm oauth_token_enc precedent); the console only ever sees
-- api_key_hint. leadwolf_app is REVOKEd entirely in applyMigrations — this table is NOT master_*-prefixed,
-- so the convention loop does NOT cover it and the explicit REVOKE there is load-bearing.

CREATE TABLE IF NOT EXISTS "provider_origins" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "provider" varchar(50) NOT NULL,
  "label" varchar(100) NOT NULL,
  "base_url" varchar(500) NOT NULL,
  "api_key_enc" bytea,
  "api_key_hint" varchar(12),
  "priority" integer NOT NULL DEFAULT 100,
  "paused" boolean NOT NULL DEFAULT false,
  "last_ok_at" timestamptz,
  "consecutive_failures" integer NOT NULL DEFAULT 0,
  "last_error" varchar(500),
  "last_error_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_provider_origins_provider_url"
  ON "provider_origins" ("provider", "base_url");
