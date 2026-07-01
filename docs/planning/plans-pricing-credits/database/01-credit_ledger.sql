-- ============================================================================
-- 01-credit_ledger.sql  —  DRAFT  —  [M11-ledger]  (TENANT DATA, posture A)
-- The program keystone (OD-6, Phase 3). Append-only, signed-delta credit
-- ledger. Reuses audit 03-billing §7.1 verbatim; entry-type vocabulary from
-- ADR-0029. Counter (tenants.reveal_credit_balance) becomes a DERIVED CACHE of
-- this ledger after M11. INVARIANT: balance == SUM(delta) per tenant.
-- Hand-authored migration only (no generate). UPDATE/DELETE blocked by trigger.
-- ============================================================================

CREATE TABLE credit_ledger (
  id              uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- M12 scoping (NULL on tenant-pool entries): a workspace/team lease books
  -- against a budget row; lets the recon worker prove per-scope balances too.
  workspace_id    uuid        REFERENCES workspaces(id) ON DELETE SET NULL,
  budget_id       uuid        REFERENCES credit_budgets(id) ON DELETE SET NULL,  -- [M12-lease]
  -- ADR-0029 entry-type vocabulary (closed). delta sign per type below.
  entry_type      varchar(20) NOT NULL,
  delta           integer     NOT NULL,         -- signed; grant/release/credit_back > 0, spend/settle/lease < 0
  balance_after   integer,                      -- optional materialized running balance (per tenant) for fast reads
  -- Idempotency: dedupe key per logical event. reveal:<id> / grant:<stripe_event_id>
  -- / lease:<job_id> / settle:<job_id> / release:<job_id> / adjust:<idem_key>.
  idempotency_key varchar(255) NOT NULL,
  reveal_id       uuid        REFERENCES contact_reveals(id) ON DELETE SET NULL,
  purchase_id     uuid        REFERENCES purchases(id)       ON DELETE SET NULL,
  job_id          uuid,                          -- bulk lease/settle/release correlation (ADR-0038)
  actor_user_id   uuid        REFERENCES users(id),          -- NULL = system/automation
  reason          varchar(255),                  -- required for adjustment/credit_back (operator note)
  metadata        jsonb       NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT credit_ledger_entry_type_enum CHECK (
    entry_type IN ('grant','spend','credit_back','adjustment','lease','settle','release')
  ),
  -- Sign discipline per ADR-0029 (lease reserves worst-case as negative;
  -- release returns worst-case positive; settle posts actual negative).
  CONSTRAINT credit_ledger_delta_sign CHECK (
    (entry_type IN ('grant','credit_back','release') AND delta >= 0)
    OR
    (entry_type IN ('spend','lease','settle')        AND delta <= 0)
    OR
    (entry_type =  'adjustment')                       -- adjustment may be ±
  )
);

-- Exactly-once: one ledger row per (tenant, idempotency_key). A retried grant /
-- reveal / lease / settle / release / adjust replays to the SAME row.
CREATE UNIQUE INDEX uniq_credit_ledger_tenant_idem
  ON credit_ledger (tenant_id, idempotency_key);

-- Balance/recon read: SUM(delta) WHERE tenant_id ORDER BY created_at — index the
-- recency prefix so per-tenant history + the invariant scan stay index-backed.
CREATE INDEX idx_credit_ledger_tenant_created
  ON credit_ledger (tenant_id, created_at DESC);

-- Per-scope (M12) balance proof.
CREATE INDEX idx_credit_ledger_budget
  ON credit_ledger (budget_id, created_at DESC) WHERE budget_id IS NOT NULL;

-- Open-lease reaper sweep: leases with no matching settle (crashed worker).
CREATE INDEX idx_credit_ledger_job_lease
  ON credit_ledger (job_id) WHERE entry_type = 'lease';

-- ── RLS (posture A — TENANT DATA, rls/billing.sql) ─────────────────────────
-- ALTER TABLE credit_ledger ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY credit_ledger_tenant_isolation ON credit_ledger
--   USING (tenant_id = current_setting('app.tenant_id')::uuid);
-- Append-only: block UPDATE/DELETE for ALL roles (same trigger as audit_log).
-- CREATE TRIGGER credit_ledger_block_mutations
--   BEFORE UPDATE OR DELETE ON credit_ledger
--   FOR EACH ROW EXECUTE FUNCTION block_mutations();
--
-- SECURITY (security has final say): writes only inside the reveal/grant/lease
-- transactions that already FOR UPDATE the counter (07 §3) — never a bare
-- INSERT path from a route. Admin adjustments consume a JIT elevation in the
-- SAME tx (ADR-0011). The counter CHECK (>=0) AND the ledger invariant both
-- hold at every instant (ADR-0029).
