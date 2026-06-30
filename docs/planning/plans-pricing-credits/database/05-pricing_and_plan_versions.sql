-- ============================================================================
-- 05-pricing_and_plan_versions.sql  —  DRAFT  (PLATFORM CONFIG, posture B)
-- REUSES the audit table designs verbatim — do NOT re-audit:
--   credit_pack_prices     : audit 05-pricing §7.1 (history) + §7.2 (currency)
--   plan_features          : audit 04-plans §7.1 (entitlement registry, G1)
--   plan_template_versions : audit 04-plans §7.2 (version history, G4)
--   plan_template_variants : audit 04-plans §7.3 (currency/region axis, G7)
-- All owner-written (withPlatformTx), deny-all to leadwolf_app
-- (rls/platformOps.sql + REVOKE ALL in applyMigrations.ts). Hand-authored only.
-- ============================================================================

-- ── credit_pack_prices  [Stripe-adjacent] [flag] — 05-pricing §7.1 + §7.2 ────
-- Immutable archive-and-replace price book. credit_packs (platformOps.ts) stays
-- the CURRENT OFFER view; this is the historical RECORD. On every economics-
-- changing upsert: close the current row (effective_to = now()) and INSERT a
-- new one in the SAME withPlatformTx. Multi-currency via the `currency` column
-- (OD-5: USD authoritative). Append-only (block_mutations).
CREATE TABLE credit_pack_prices (
  id            uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  pack_key      text        NOT NULL,                 -- credit_packs.key (snapshot, not FK — pack may retire)
  currency      char(3)     NOT NULL DEFAULT 'USD',
  price_cents   integer     NOT NULL,
  credits       integer     NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to  timestamptz,                          -- NULL = current price for (pack_key, currency)
  created_by    uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT credit_pack_prices_amounts CHECK (price_cents >= 0 AND credits > 0)
);

-- Exactly one CURRENT price per (pack_key, currency).
CREATE UNIQUE INDEX uniq_credit_pack_prices_current
  ON credit_pack_prices (pack_key, currency) WHERE effective_to IS NULL;
CREATE INDEX idx_credit_pack_prices_history
  ON credit_pack_prices (pack_key, currency, effective_from DESC);

-- ── plan_features  — 04-plans §7.1 (entitlement registry, addresses G1) ──────
CREATE TABLE plan_features (
  id          uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  key         text        NOT NULL UNIQUE,           -- the entitlement key used in plan_templates.features
  label       text        NOT NULL,
  description text,
  category    text,
  value_type  varchar(20) NOT NULL DEFAULT 'boolean', -- boolean | number | enum (entitlement shape)
  active      boolean     NOT NULL DEFAULT true,
  sort_order  integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT plan_features_value_type_enum CHECK (value_type IN ('boolean','number','enum'))
);
CREATE INDEX idx_plan_features_active ON plan_features (active, sort_order);

-- ── plan_template_versions  — 04-plans §7.2 (version history, addresses G4) ──
-- Append-only snapshot per upsert; never updated. Substrate for grandfathering
-- (subscriptions.plan_template_version_id pins a version).
CREATE TABLE plan_template_versions (
  id              uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  plan_template_key text      NOT NULL,
  version         integer     NOT NULL,              -- monotonic per key
  name            text        NOT NULL,
  seat_limit      integer     NOT NULL,
  workspace_limit integer,
  monthly_credit_grant integer,
  features        jsonb       NOT NULL DEFAULT '{}',  -- snapshot of the entitlement map THEN
  created_by      uuid        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uniq_plan_template_versions_key_ver
  ON plan_template_versions (plan_template_key, version);
CREATE INDEX idx_plan_template_versions_key
  ON plan_template_versions (plan_template_key, version DESC);

-- ── plan_template_variants  — 04-plans §7.3 (currency/region axis, G7) ───────
-- Priced instances of the logical plan product; keep plan_templates as the
-- product, variants as the priced rows. [decision-gated] on a paid-plan model.
CREATE TABLE plan_template_variants (
  id                uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  plan_template_key text        NOT NULL,
  currency          char(3)     NOT NULL DEFAULT 'USD',
  region            text        NOT NULL DEFAULT 'global',
  price_cents       integer     NOT NULL,
  interval          varchar(20) NOT NULL DEFAULT 'month',  -- month | year (opt-in annual, ADR-0041)
  stripe_price_id   varchar(255),                          -- [Stripe] the Stripe Price object
  active            boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT plan_template_variants_interval_enum CHECK (interval IN ('month','year')),
  CONSTRAINT plan_template_variants_price_nonneg CHECK (price_cents >= 0)
);
CREATE UNIQUE INDEX uniq_plan_template_variants
  ON plan_template_variants (plan_template_key, currency, region, interval) WHERE active = true;

-- ── RLS (posture B for ALL four) ──
-- NO tenant_id. Owner-connection-only (withPlatformTx); deny-all to leadwolf_app
-- (rls/platformOps.sql + REVOKE ALL ... FROM leadwolf_app in applyMigrations.ts).
-- The PUBLIC pricing page reads the current offer via a SEPARATE read-only
-- connection path (audit 05-pricing §8.1) — the RLS REVOKE is NEVER relaxed for
-- the app role (security has final say). credit_pack_prices + plan_template_
-- versions are append-only (block_mutations trigger).
