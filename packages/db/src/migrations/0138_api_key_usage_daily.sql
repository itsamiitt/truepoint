-- 0138_api_key_usage_daily.sql — the public API's usage read model (ADR-0049) [A-01]
-- HAND-AUTHORED, additive-only. No drizzle-kit generate — the snapshot chain stopped at 0107 (see 0137).
--
-- WHY A DAILY ROLLUP AND NOT AN EVENT LOG. One row per (key, day, endpoint), upserted per call. A per-call
-- table on a public API grows without bound and makes "this month's usage" an aggregate over millions of
-- rows; this bounds it to at most (keys × endpoints) rows per day, forever, and the dashboard read is a
-- straight index range scan. The cost is one extra upsert per request — a fixed cost at the cheap end.
--
-- WHY NOT usage_event. It is the Phase-1 entitlement spine and it is the wrong instrument here: no
-- api_key_id column (so per-key attribution is impossible), a closed `action` CHECK that would have to move
-- in three places at once, and a cap reader that counts rows rather than summing quantity. Widening it to
-- carry this would make it worse at its own job. The two coexist.
--
-- NO FK TO api_keys, DELIBERATELY. Usage outlives the credential. A customer reconciling an invoice against
-- last month's spend must not lose that history because they rotated or deleted a key, so this table
-- references the id without a constraint that would cascade the rows away.
--
-- THIS IS A COUNTER, NOT A BILLING RECORD. credits_spent is a denormalized copy for display; the credit
-- ledger (ADR-0029) is the money's source of truth. Nothing reconciles against this table, on purpose — a
-- second money source is how ledgers rot.
--
-- RLS + GRANT land via rls/apiKeys.sql on the same migrate.
--
-- DOWN (manual; forward-only project): DROP TABLE api_key_usage_daily.

CREATE TABLE IF NOT EXISTS api_key_usage_daily (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  api_key_id    uuid NOT NULL,
  day           date NOT NULL,
  endpoint      varchar(64) NOT NULL,
  calls         integer NOT NULL DEFAULT 0,
  billed_calls  integer NOT NULL DEFAULT 0,
  credits_spent integer NOT NULL DEFAULT 0,
  CONSTRAINT api_key_usage_daily_pk PRIMARY KEY (tenant_id, api_key_id, day, endpoint),
  -- Counters only ever move up, and billed calls are a subset of calls. A negative or over-counted row is a
  -- bug in the upsert, and it is cheaper to reject it here than to explain it on an invoice later.
  CONSTRAINT api_key_usage_daily_counts_sane CHECK (
    calls >= 0 AND billed_calls >= 0 AND credits_spent >= 0 AND billed_calls <= calls
  )
);
--> statement-breakpoint
-- The dashboard read: one tenant, a date window. tenant_id leads, per tenancy.md.
CREATE INDEX IF NOT EXISTS api_key_usage_daily_tenant_day_idx
  ON api_key_usage_daily (tenant_id, day DESC);
--> statement-breakpoint
COMMENT ON TABLE api_key_usage_daily IS
  'Per-key/day/endpoint API usage rollup for the customer dashboard (ADR-0049). A counter, not a billing record — the credit ledger is the money source of truth.';
