-- 0130_market_rollups.sql — the materialized market-segment rollup [S-01][S-02]
-- (hand-authored, additive-only; docs/planning/market-intelligence/06-architecture.md MI-S7/§4).
--
-- The AGGREGATION SEAM the pipelines scan said did not exist: segment boards aggregate across thousands
-- of companies, so the per-company "no stored rollup" precedent (0114 header) deliberately does NOT apply
-- here — that rule was about cheap client-side derivation over ≤25 rows; a board cannot derive across the
-- graph per request. This is the ARGUED departure doc 06 §4 records, Postgres-first per the 2026-08-18
-- decision, with the revisit trigger: rebuild runtime > 15 min or board p95 > 1s for two consecutive
-- weeks → evaluate a columnar store.
--
-- CONTENTS ARE NON-PII BY CONSTRUCTION: counts and sums over organization dimensions
-- (industry code × HQ country × employee band × month). No ids, no names, no person data — safe to
-- serve to any authenticated customer as market context.
--
-- REBUILD SEMANTICS: a derived CACHE, not a fact store — the sweep DELETEs and re-INSERTs the whole
-- window in one transaction (rebuildable-from-Layer-0, the tenant_signals §3 philosophy). Dimension
-- sentinels: '' = unclassified/unknown, so the PK never needs a nullable column.
--
-- ACL: master_-prefixed → the ^master_ REVOKE wall covers the app role. leadwolf_er gets SELECT only
-- (the API read seam); the REBUILD runs on the owner connection inside the system sweep — the one
-- deliberate exception to "er writes Layer 0", because a cache rebuild needs DELETE and the er role's
-- never-DELETE posture is worth keeping intact.

CREATE TABLE IF NOT EXISTS master_market_rollups (
  industry_code        varchar(50) NOT NULL DEFAULT '',
  hq_country           varchar(60) NOT NULL DEFAULT '',
  employee_band        varchar(20) NOT NULL DEFAULT '',
  month                date        NOT NULL,
  company_count        integer     NOT NULL DEFAULT 0,
  headcount_delta      bigint      NOT NULL DEFAULT 0,
  funding_rounds       integer     NOT NULL DEFAULT 0,
  funding_amount_minor bigint      NOT NULL DEFAULT 0,
  signal_count         integer     NOT NULL DEFAULT 0,
  rebuilt_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT master_market_rollups_pk PRIMARY KEY (industry_code, hq_country, employee_band, month),
  CONSTRAINT master_market_rollups_month_canonical CHECK (month = date_trunc('month', month)::date)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_master_market_rollups_month ON master_market_rollups (month DESC);
