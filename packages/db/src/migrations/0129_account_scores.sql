-- 0129_account_scores.sql — account-grain scoring history [S-01][S-02]
-- (hand-authored, additive-only; docs/planning/market-intelligence/06-architecture.md MI-S4).
--
-- Before this, `scores` was contact_id NOT NULL — no account-level score existed anywhere, and
-- accounts.icp_fit_score was a bare int with no model, no breakdown, no history, no writer
-- (02-gap-analysis). This is the `scores` pattern cloned at the account grain: APPEND-per-rescore, a
-- model_version on every row, a breakdown jsonb that explains every point, and a trigger keeping
-- accounts.icp_fit_score as a CACHE of the latest fit (the scores→contacts.priority_score precedent —
-- the cached column is FIT, matching its name, never the composite).
--
-- INPUTS ARE COMPANY FACTS ONLY (03-scope §4 guard, risk 3): firmographics + delivered tenant_signals
-- recency. No topic/keyword/visit input exists or may be added without a decisions.md entry — momentum
-- is not intent (X-04 stays out). RLS + grants via rls/accountScores.sql.

CREATE TABLE IF NOT EXISTS "account_scores" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "model_version" varchar(20) NOT NULL,
  "icp_fit" integer NOT NULL,
  "momentum" integer NOT NULL,
  "composite" integer NOT NULL,
  "breakdown" jsonb NOT NULL DEFAULT '{}',
  "scored_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "account_scores_ranges" CHECK (
    "icp_fit" BETWEEN 0 AND 100 AND "momentum" BETWEEN 0 AND 100 AND "composite" BETWEEN 0 AND 100
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_account_scores_ws_account"
  ON "account_scores" ("workspace_id", "account_id", "scored_at" DESC);
