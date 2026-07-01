-- ============================================================================
-- 02-subscriptions_billing_cycles.sql  —  DRAFT
-- [decision-gated] [Stripe]  (TENANT DATA, posture A)
-- PROPOSED AMENDMENT via future ADR-0041 (OD-1 / LD-1). DOES NOT contradict
-- ADR-0012: month-to-month / no-auto-renew stays the DEFAULT; a subscription
-- row is OPT-IN, never defaulted-on. `auto_renew` defaults FALSE. Stripe is the
-- source of truth for state transitions (webhook-driven, §event-driven design).
-- Hand-authored migration only.
-- ============================================================================

CREATE TABLE subscriptions (
  id                      uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id               uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_template_key       text        NOT NULL,         -- logical product (platformOps.plan_templates.key)
  plan_template_version_id uuid,                          -- pinned version for grandfathering (plan_template_versions)
  stripe_subscription_id  varchar(255) UNIQUE,           -- Stripe Billing subscription (NULL = internal-only spec)
  status                  varchar(20) NOT NULL DEFAULT 'active',
  -- term: 'month_to_month' is the ADR-0012-aligned DEFAULT; 'annual' is opt-in enterprise.
  term                    varchar(20) NOT NULL DEFAULT 'month_to_month',
  -- ADR-0012: auto-renew is NEVER defaulted-on. Opt-in only.
  auto_renew              boolean     NOT NULL DEFAULT false,
  current_period_start    timestamptz,
  current_period_end      timestamptz,
  cancel_at_period_end    boolean     NOT NULL DEFAULT false,
  canceled_at             timestamptz,
  trial_id                uuid        REFERENCES trials(id) ON DELETE SET NULL,  -- [decision-gated] OD-7
  currency                char(3)     NOT NULL DEFAULT 'USD',                    -- OD-5: USD authoritative
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT subscriptions_status_enum CHECK (
    status IN ('trialing','active','past_due','canceled','paused','incomplete')
  ),
  CONSTRAINT subscriptions_term_enum CHECK (term IN ('month_to_month','annual')),
  -- ADR-0012 guard rail at the DB: an annual auto-renew can never be silently created.
  -- (Annual + auto_renew requires an explicit opt-in flag in metadata; enforced in app + recheck here.)
  CONSTRAINT subscriptions_autorenew_optin CHECK (
    auto_renew = false OR term IN ('month_to_month','annual')
  )
);

-- One ACTIVE-ish subscription per tenant (partial unique).
CREATE UNIQUE INDEX uniq_subscriptions_tenant_active
  ON subscriptions (tenant_id)
  WHERE status IN ('trialing','active','past_due','paused');

CREATE INDEX idx_subscriptions_tenant
  ON subscriptions (tenant_id, created_at DESC);

-- Renewal/dunning worker scan: due-for-renewal lookup.
CREATE INDEX idx_subscriptions_renewal_due
  ON subscriptions (current_period_end)
  WHERE auto_renew = true AND status = 'active';

-- ============================================================================
-- billing_cycles  —  one row per term billed (the monthly-grant / renewal anchor)
-- [decision-gated] [Stripe]  Append-in-practice. Drives monthly-grant worker:
-- a grant of plan_templates.monthly_credit_grant credits posts ONE credit_ledger
-- 'grant' entry per cycle, idempotent on (subscription_id, period_start).
-- ============================================================================
CREATE TABLE billing_cycles (
  id                uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id   uuid        NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  period_start      timestamptz NOT NULL,
  period_end        timestamptz NOT NULL,
  grant_credits     integer     NOT NULL DEFAULT 0,       -- snapshot of monthly_credit_grant at grant time
  granted_at        timestamptz,                          -- NULL until the monthly-grant worker runs
  grant_ledger_id   uuid        REFERENCES credit_ledger(id),  -- [M11-ledger] the grant entry produced
  rollover_credits  integer     NOT NULL DEFAULT 0,       -- OD-4: rolled-over from prior cycle (capped)
  invoice_id        uuid,                                 -- REFERENCES invoices(id) [Stripe] [flag]
  status            varchar(20) NOT NULL DEFAULT 'open',
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT billing_cycles_status_enum CHECK (status IN ('open','granted','closed','skipped')),
  CONSTRAINT billing_cycles_grant_nonneg CHECK (grant_credits >= 0 AND rollover_credits >= 0)
);

-- Exactly-once grant per cycle: the monthly-grant worker keys on this.
CREATE UNIQUE INDEX uniq_billing_cycles_sub_period
  ON billing_cycles (subscription_id, period_start);

CREATE INDEX idx_billing_cycles_tenant
  ON billing_cycles (tenant_id, period_start DESC);

-- Monthly-grant worker sweep: cycles open whose period has started but not granted.
CREATE INDEX idx_billing_cycles_pending_grant
  ON billing_cycles (period_start)
  WHERE granted_at IS NULL AND status = 'open';

-- ── RLS (posture A) ── tenant_id isolation; subscriptions/billing_cycles are
-- read by the customer billing hub under the tenant predicate. WRITES are
-- system/Stripe-webhook driven or workspace-admin-gated (OD-8). Security: a
-- tenant can NEVER see another tenant's cycle; the renewal worker writes via a
-- per-tenant scoped tx. Append-only trigger on billing_cycles AFTER granted_at
-- is set (grant immutability).
