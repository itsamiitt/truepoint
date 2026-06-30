-- ============================================================================
-- 06-credit_budgets_allocation.sql  —  DRAFT  —  [M12-lease] [decision-gated]
-- (TENANT DATA, posture A)  OD-2 / LD-2: the hierarchical org -> team/workspace
-- -> per-user allocation target. The tenant pool (tenants.reveal_credit_balance
-- / the M11 ledger) stays AUTHORITATIVE. Budgets SUBDIVIDE it; per-user limits
-- are SOFT caps. Rides the ADR-0029 M12 lease primitive; proposed ADR-0042;
-- aligns with ADR-0022 (departments/teams intra-workspace segmentation).
-- Hand-authored migration only.
-- ============================================================================

-- ── credit_budgets — per workspace OR per team cap that subdivides the pool ──
-- A budget is a LEASE row in the M12 sense: the per-reveal lock contends on this
-- row, not the tenant row (relieves G-BIL-2 hot-lock). Exhaustion falls back to
-- the tenant pool; correctness preserved by the ledger + CHECK >= 0 (ADR-0029).
CREATE TABLE credit_budgets (
  id              uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope           varchar(20) NOT NULL,                  -- workspace | team
  workspace_id    uuid        REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id         uuid,                                  -- REFERENCES teams(id) (ADR-0022 segmentation)
  -- The reserved allocation (lease size). balance == allocation − leased spend,
  -- reconciled to the ledger (credit_ledger.budget_id) asynchronously.
  allocation      integer     NOT NULL DEFAULT 0,        -- CHECK >= 0
  reserved        integer     NOT NULL DEFAULT 0,        -- currently leased from the tenant pool
  spent           integer     NOT NULL DEFAULT 0,        -- settled spend against this budget
  period          varchar(20) NOT NULL DEFAULT 'none',   -- none | monthly (resettable budget window)
  period_start    timestamptz,
  hard_cap        boolean     NOT NULL DEFAULT false,    -- true = block at budget; false = soft (warn, fall back to pool)
  active          boolean     NOT NULL DEFAULT true,
  created_by_user_id uuid     NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT credit_budgets_scope_enum CHECK (scope IN ('workspace','team')),
  CONSTRAINT credit_budgets_amounts CHECK (allocation >= 0 AND reserved >= 0 AND spent >= 0),
  -- scope ↔ id coherence (mirrors suppression_list pattern).
  CONSTRAINT credit_budgets_scope_coherence CHECK (
       (scope = 'workspace' AND workspace_id IS NOT NULL AND team_id IS NULL)
    OR (scope = 'team'      AND team_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uniq_credit_budgets_ws
  ON credit_budgets (tenant_id, workspace_id) WHERE scope = 'workspace' AND active = true;
CREATE UNIQUE INDEX uniq_credit_budgets_team
  ON credit_budgets (tenant_id, team_id) WHERE scope = 'team' AND active = true;
CREATE INDEX idx_credit_budgets_tenant ON credit_budgets (tenant_id, id);

-- ── user_credit_limits — per-user SOFT spend cap within a budget/workspace ───
-- SOFT by design: a limit warns + optionally blocks, but the authoritative debit
-- is still the budget/tenant ledger entry. Never the source of truth for balance.
CREATE TABLE user_credit_limits (
  id              uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id    uuid        REFERENCES workspaces(id) ON DELETE CASCADE,
  budget_id       uuid        REFERENCES credit_budgets(id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  limit_credits   integer     NOT NULL,                  -- soft cap per period
  used_credits    integer     NOT NULL DEFAULT 0,
  period          varchar(20) NOT NULL DEFAULT 'monthly',
  period_start    timestamptz NOT NULL DEFAULT now(),
  enforce         boolean     NOT NULL DEFAULT false,    -- false = warn only; true = block at cap
  created_by_user_id uuid     NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT user_credit_limits_amounts CHECK (limit_credits >= 0 AND used_credits >= 0)
);

CREATE UNIQUE INDEX uniq_user_credit_limits
  ON user_credit_limits (tenant_id, workspace_id, user_id);
CREATE INDEX idx_user_credit_limits_user
  ON user_credit_limits (user_id, period_start DESC);

-- ── RLS (posture A) ──
-- Both carry tenant_id; tenant-isolated. The allocation UI reads under the
-- tenant predicate. WRITES are workspace-admin-gated (OD-8: web workspace-admin
-- only purchase/allocate). Security: a workspace admin can allocate ONLY within
-- their own tenant/workspace; the budget/limit IDs from the client are NEVER
-- trusted — every write re-resolves scope from the authenticated context and
-- re-checks the tenant predicate (RLS) + ownership. Budget debit composes with
-- the tenant pool: a standing lease reserves from the BUDGET row, falling back
-- to the tenant row, both bounded by CHECK >= 0 (ADR-0029 §M12).
