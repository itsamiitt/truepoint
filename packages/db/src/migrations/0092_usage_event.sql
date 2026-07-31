-- 0092_usage_event.sql — the outcome-metric substrate (docs/strategy/08-architecture.md § Instrumentation:
-- "Emit from day one"; 06-roadmap Phase 1). EXPAND ONLY: created empty, nothing reads or writes it until the
-- emitter lands and USAGE_EVENTS_ENABLED is flipped.
--
-- WHY A NEW TABLE WHEN FIVE METERS ALREADY EXIST
-- contact_reveals, credit_ledger, provider_calls, ai_requests and activities each meter one domain, with no
-- shared shape and no common key. None of them can answer "what is the reveal-hit rate", "how long did a
-- reveal take", or "did the badge render" — the questions the Phase 1 acceptance criteria are written in.
-- This table does NOT replace any of them: they keep metering billing and interaction independently, and
-- deliberately so, because a metric surface and a money surface should never be the same rows.
--
-- Shaped on ai_requests (the shipped metered-request log): workspace RLS, append-only in practice, user_id
-- ON DELETE SET NULL so metering history survives a member's removal — a departing rep must not retroactively
-- shrink last quarter's numbers.
--
-- reveal_miss rides in HERE rather than in its own table (08 lists a reveal_miss entity). Structurally it is a
-- usage event with a fingerprint and a demanded-field list, and folding it in means one egress to suppress,
-- one retention class, one partition strategy, and the most-wanted feed is a GROUP BY rather than a join. A
-- dedicated table remains possible later as a pure projection off this one.
--
-- COMPLIANCE (09 rule 3, and the reason subject_fingerprint is bytea rather than text): a reveal-miss records
-- that somebody was LOOKED FOR and not found. Storing the LinkedIn slug or email that was searched would make
-- this log a shadow database of people we hold nothing about — the exact thing an opt-out cannot reach,
-- because there is no record to suppress. So the fingerprint is a keyed HMAC sharing its key space with
-- master_emails.email_blind_index and suppression_list.email_blind_index, which means a suppression check can
-- still MATCH it without the log ever holding the identifier. metadata is PII-free by contract.
--
-- Partitioned monthly from day one, while empty. The sweep is catalog-driven (partitionRepository asks
-- pg_class for relkind='p' in public), so this is registered by existing.

CREATE TABLE IF NOT EXISTS usage_event (
  id                  uuid NOT NULL DEFAULT uuid_generate_v7(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE: metering history must survive a member's removal.
  user_id             uuid REFERENCES users(id) ON DELETE SET NULL,
  action              varchar(50) NOT NULL,
  subject_type        varchar(20),
  subject_id          uuid,          -- absent on a miss: there IS no record to point at
  subject_fingerprint bytea,         -- keyed HMAC, never a raw identifier (see the compliance note above)
  demanded_fields     text[],
  quantity            integer NOT NULL DEFAULT 1,
  entitlement_key     varchar(50),   -- which cap this counted against; NULL = unmetered
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at),
  CONSTRAINT usage_event_action_enum CHECK (action IN
    ('reveal','reveal_miss','search','export','verify','save','badge_impression','enrich')),
  CONSTRAINT usage_event_quantity_positive CHECK (quantity > 0),
  -- A miss has no subject id and MUST carry a fingerprint instead; anything else is a lookup we cannot later
  -- suppress or count. Enforced here because the alternative is discovering it in the most-wanted feed.
  CONSTRAINT usage_event_miss_shape CHECK (
    action <> 'reveal_miss' OR (subject_id IS NULL AND subject_fingerprint IS NOT NULL))
) PARTITION BY RANGE (occurred_at);
--> statement-breakpoint

SELECT ensure_month_partitions('usage_event'::regclass, 3);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS usage_event_default PARTITION OF usage_event DEFAULT;
--> statement-breakpoint

-- Cap enforcement: "how much of `key` has this tenant used this period". The leading tenant_id matches how
-- requireEntitlement asks the question.
CREATE INDEX IF NOT EXISTS idx_usage_event_cap
  ON usage_event (tenant_id, entitlement_key, occurred_at);
--> statement-breakpoint
-- The dashboards: newest-first within a workspace.
CREATE INDEX IF NOT EXISTS idx_usage_event_ws
  ON usage_event (workspace_id, occurred_at DESC);
--> statement-breakpoint
-- The most-wanted feed (07 § channel 7): GROUP BY fingerprint over misses only, so the index stays small.
CREATE INDEX IF NOT EXISTS idx_usage_event_wanted
  ON usage_event (action, subject_fingerprint)
  WHERE action = 'reveal_miss';

-- DOWN (manual — safe while USAGE_EVENTS_ENABLED is off, since nothing reads the table):
--   DROP TABLE usage_event CASCADE;
