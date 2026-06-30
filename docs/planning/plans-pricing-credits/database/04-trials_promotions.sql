-- ============================================================================
-- 04-trials_promotions.sql  —  DRAFT
-- trials       : [decision-gated] (OD-7) TENANT DATA, posture A
-- promotions   : [decision-gated] [Stripe] PLATFORM CONFIG, posture B
--                (reuses audit 05-pricing §8.2 verbatim)
-- ADR-0012: signup-bonus credits = the MVP trial (OD-7); full time-boxed trials
-- deferred. Hand-authored migration only.
-- ============================================================================

-- ── trials (TENANT DATA, posture A) ─────────────────────────────────────────
-- The MVP "trial" is signup-bonus credits: one row records the bonus grant so
-- it is never double-granted. A time-boxed trial (status='active' with ends_at)
-- is the DEFERRED extension on the same row.
CREATE TABLE trials (
  id                uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind              varchar(20) NOT NULL DEFAULT 'signup_bonus',  -- signup_bonus | time_boxed (deferred)
  bonus_credits     integer     NOT NULL DEFAULT 0,
  grant_ledger_id   uuid        REFERENCES credit_ledger(id),     -- [M11-ledger] the bonus 'grant' entry
  promotion_id      uuid        REFERENCES promotions(id) ON DELETE SET NULL,
  status            varchar(20) NOT NULL DEFAULT 'granted',       -- granted | active | expired | converted
  started_at        timestamptz NOT NULL DEFAULT now(),
  ends_at           timestamptz,                                  -- NULL for signup_bonus; set for time_boxed
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trials_kind_enum   CHECK (kind   IN ('signup_bonus','time_boxed')),
  CONSTRAINT trials_status_enum CHECK (status IN ('granted','active','expired','converted')),
  CONSTRAINT trials_bonus_nonneg CHECK (bonus_credits >= 0)
);

-- One signup-bonus trial per tenant (idempotent bonus grant).
CREATE UNIQUE INDEX uniq_trials_tenant_signup
  ON trials (tenant_id) WHERE kind = 'signup_bonus';

-- ── promotions (PLATFORM CONFIG, posture B — reuse 05-pricing §8.2) ──────────
-- Owner-written (withPlatformTx), deny-all to leadwolf_app. promotion.set audit
-- action; pricing:manage-gated CRUD mirroring the credit_packs recipe. Deferred
-- on the business pricing decision (ADR-0012 placeholders).
CREATE TABLE promotions (
  id                uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  code              text        NOT NULL UNIQUE,
  kind              varchar(20) NOT NULL,         -- percent | fixed | bonus_credits
  value             integer     NOT NULL,         -- percent(0-100) | cents | credits, per kind
  currency          char(3),                      -- for kind=fixed; NULL otherwise (OD-5 USD default)
  starts_at         timestamptz,
  ends_at           timestamptz,
  max_redemptions   integer,                      -- NULL = unlimited
  redemptions       integer     NOT NULL DEFAULT 0,
  active            boolean     NOT NULL DEFAULT true,
  created_by_user_id uuid       NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT promotions_kind_enum CHECK (kind IN ('percent','fixed','bonus_credits')),
  CONSTRAINT promotions_value_nonneg CHECK (value >= 0),
  CONSTRAINT promotions_percent_range CHECK (kind <> 'percent' OR value BETWEEN 0 AND 100)
);

CREATE INDEX idx_promotions_active ON promotions (active, id);

-- ── RLS ──
-- trials (posture A): tenant_id isolation; read by the billing hub; bonus grant
--   written system-side in the same tx as the credit_ledger 'grant' entry.
-- promotions (posture B): NO tenant_id; owner-only; deny-all to leadwolf_app
--   (rls/platformOps.sql + REVOKE ALL in applyMigrations.ts). Redemption is
--   validated server-side; the redemption COUNTER increments under the platform
--   tx, never client-trusted. Security: a promo code is untrusted input —
--   validate kind/value/window/cap before any credit grant.
