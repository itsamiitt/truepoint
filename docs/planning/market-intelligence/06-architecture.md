# 06 — Architecture changes

Pre-build reasoning pass (truepoint-architecture) answers embedded per section:
source-of-truth, failure modes, idempotency, rollback. Schema work uses step IDs
(MI-S1…), numbers taken at PR time.

## 1. Schema deltas — deliberately few

| Step | Delta | Layer | Notes |
|---|---|---|---|
| MI-S1 | `master_job_postings` (company FK, title, department, seniority, location, posted_at, closed_at, canonical_url UNIQUE-per-source, evidence_ref) — partitioned by posted_at | 0 | New entity (doc 02 ABSENT). `master_`-prefixed → automatic grant-off; hand-authored migration outside the barrel like other partitioned tables |
| MI-S2 | `master_funding_participants` (funding_id, investor_company_id, role lead/participant) | 0 | Deferred until a feed supplies participants; `lead_investor_company_id` suffices for v1 |
| MI-S3 | `master_industries` (hierarchy: id, parent_id, code, label) + `master_industry_aliases` (vendor string → node) + nullable `industry_id` on `master_companies`/`accounts` | 0/1 | Pattern: `master_technology_categories` tree. Free-text columns stay (raw), node is canonical. Backfill via alias-match sweep |
| MI-S4 | `account_scores` (account_id, model_version, icp_fit, momentum, composite, breakdown jsonb, computed_at) — append-per-rescore | 1 | Clone of `scores` shape at account grain; RLS like `scores` |
| MI-S5 | `watchlists` (workspace-scoped) + `watchlist_members` (account_id) + `signal_subscriptions` (watchlist_id or saved_search_id, family[], channel in_app/digest) | 1 | Tenant tables, standard RLS |
| MI-S6 | `tenant_signals` — Layer-1 projection of `master_signals` fan-out (tenant_id, workspace_id, account_id/contact_id, signal ref, delivered_at) | 1 | Resolves the carried open question "master_signals vs intent_signals relationship": Layer 0 = shared fact, Layer 1 = tenant copy that scoring + alerts read. `intent_signals` stays for its shipped `job_change` path; new families land in `tenant_signals`, and a later step migrates job_change onto it |
| MI-S7 | `market_rollups` materialized rollup table(s): (industry_id, geo, size_band, month) → counts, headcount delta, funding sum | 0-derived, no PII | Rebuilt by sweep; safe to TRUNCATE + rebuild (idempotent) |

**Explicitly no new tables for:** funding (exists), technographics (exists), signals
vocabulary (lookup rows, not DDL), headcount (exists), news (rides `master_signals`).

## 2. Producers (workers)

New/changed queues in `apps/workers/src/register.ts`, all leader-locked sweeps behind
env gates, standard DLQ + metrics:

- `leadership_signal` emitter — inside `landSourcePayload` (no new queue): employment
  delta at seniority c_suite/vp → `exec_hired/departed` signal. Idempotency: signal
  dedup key (subject, type, observed_at bucket, evidence_ref).
- `funding_ingest` — vendor batch → `master_company_funding` upsert + `funding` signals.
  Idempotent on `source_records.content_hash`.
- `postings_ingest` — feed batch → MI-S1 upsert + surge detection (`job_posting_surge`,
  `key_role_opened`) with thresholds in code constants first, policy table later.
- `signal_fanout` — drains new Layer-0 signals → `tenant_signals` for workspaces whose
  accounts bridge to the subject company (`master_company_id` bridge). Census on owner
  connection returns ids only; writes per-workspace `withTenantTx` (C-02 pattern).
  At-least-once + dedup on (workspace, signal id).
- `account_scoring` — recompute MI-S4 on new tenant signal / facet change; clone of the
  contact scoring worker.
- `market_rollup_sweep` — rebuilds MI-S7 monthly buckets; failure mode = stale board,
  never wrong-tenant data (rollups are Layer-0 aggregates over non-PII fields).
- `alert_dispatch` — subscription match → notifications row (+ digest batcher).
  Failure mode: missed alert ≤ next sweep; no duplicate sends (delivery ledger).

## 3. The fan-out decision (source of truth)

Layer-0 `master_signals` is the single source of truth for events; `tenant_signals` is
a delivery/read projection, never edited. Conflict rule: Layer 0 wins; projections are
rebuildable from the log (same philosophy as `field_provenance` vs `provenance_event`).

## 4. Aggregation seam + the no-rollup precedent

The headcount route's "no stored growth number" rule was correct at per-company grain
(cheap client-side derivation). Market boards aggregate across thousands of companies —
client-side derivation is impossible, so MI-S7 materializes. This is an argued
departure from the precedent, not a silent one. Postgres-first per the 2026-08-18
decision; **revisit trigger** (mirroring `intelligence-platform/03` Group A): rollup
sweep runtime > 15 min or board p95 > 1s for two consecutive weeks → evaluate a
columnar store. `SearchPort` is not extended — boards get their own thin
`marketRollupRepository` read seam (SearchPort as typed cannot express aggregates;
pipelines scan conclusion 3).

## 5. Confidence unification (C9) — prerequisite, not optional

Market surfaces sell freshness (S-10). Shipping account pages on the forked model means
badge math diverges from `master_confidence_policy` half-lives the moment policy rows
feed anything. Adopt the handover's recommendation: **keep the shipped
`buildConfidenceBadgeV1` leaf function, source its constants from
`master_confidence_policy`** (display-only first, then ranking, then gating — the
rollout discipline from `intelligence-platform/03` §4). Badge-band movement (documented
deltas 0.09–0.17) is announced, not silent — a doc 09 decision.

## 6. API surface

Extend `account-intelligence` + add siblings (all `/api/v1`, cursor pagination,
RFC 9457, idempotency on writes):
- `GET /accounts/:id/funding`, `/postings`, `/signals` (account-side; contact-side exists)
- `GET/POST/DELETE /watchlists`, `/watchlists/:id/members`, `/signal-subscriptions`
- `GET /market/segments` (board query over MI-S7), `GET /market/movers`
- `POST /account-search` gains `industry_id` + `signal_recency` facets (both already
  named in doc 24's filter semantics)

## 7. Entitlements

Market-intel reads are metered visibility, not credit-settled reveals (credits stay the
PII-reveal settlement unit — rule 7 amendment). Gate account pages/watchlists/boards by
plan feature flags (`plan_templates.features`), enforced via the existing shadow-mode
`requireEntitlement` path. No new currency of any kind.

## 8. Rollback

Every producer is a gated sweep: gate off = production identical. MI-S7 rollups
truncate-and-rebuild. MI-S6 projections rebuild from Layer 0. Schema steps are
additive-only (the intelligence-platform convention); no destructive migration in the
series.
