# 10 — Enablement runbook (MI-9)

The build is complete and everything ships DARK. This runbook is the deploy-side half: the ordered flag
flips that light the pipeline up, with prerequisites, verification probes, and rollback per stage. Every
gate is an env kill-switch, default-off, explicit-`"true"`-only; **rollback for every stage is: unset the
variable and restart — flag-off is byte-identical by construction and test.**

Operator surfaces referenced: the admin **Data sources** page (linkedin_api origin fleet), **Feature
flags** console, worker logs/metrics (`collectWorkerMetricsText`), and psql probes below (run as an
operator role; the app role cannot see Layer 0 — that is the wall working).

## Ordering rule

Stages are ordered so each one's verification has data from the one before. Skipping ahead is safe
(everything degrades to honest empties) but proves nothing. One stage per deploy window; watch a full
sweep interval before the next.

## Stage 0 — prerequisites (no flags)

- `bun run db:migrate` has applied 0125–0130 (tenant_signals, watchlists, job postings, taxonomy,
  account_scores, market rollups). Probe: `SELECT count(*) FROM master_industries;` → 24.
- Redis reachable from `apps/workers` (watermarks + leader locks live there).
- A `provider_origins` row for `linkedin_api` with a working key (admin → Data sources; health probe
  green). **This is the HUMAN GATE the linkedin-source-ingestion plan records — vendor ToS/DPA review
  signed off before any key is registered.**

## Stage 1 — landing spine

Flip: `LINKEDIN_SOURCE_LANDING_ENABLED=true` (and `PROVENANCE_EVENTS_ENABLED=true` if not already on).
- Verify: land one profile via enrichment or refresh; `SELECT count(*) FROM source_records WHERE
  source_name='linkedin_api';` grows; `provenance_event` rows appear for the landed fields;
  `master_companies.industry_id` populates when the vendor spelling has an alias (0128).
- Watch: quarantine/shape-drift log lines; `landed:false reason:shape_drift` means the vendor moved the
  payload — stop, fix the mapper, do not push on.

## Stage 2 — signals

Flip: `LINKEDIN_SIGNALS_ENABLED=true`.
- Verify: after a landing with a real employer transition — `SELECT type_code, count(*) FROM
  master_signals GROUP BY 1;` shows `job_change` / `exec_hired` / `exec_departed`; company refetches past
  the threshold add `headcount_surge`/`headcount_decline`.
- Invariant (enforced in code, worth eyeballing once): no payload carries contact values —
  `assertNoContactValues` THROWS on the write path, so a violation fails the landing loudly.

## Stage 3 — refresh lanes (spend-bearing)

Flip, in this order, watching spend between each: `LINKEDIN_LINK_FETCH_ENABLED=true` →
`LINKEDIN_ACCOUNT_REFRESH_ENABLED=true` → `LINKEDIN_COMPANY_REFRESH_ENABLED=true`.
- Spend is bounded structurally (per-tick caps × cadence; the 30-day `source_fetch_registry` freshness
  clock dedups refetches). Watch the provider-calls cost feed in admin.
- Verify: `master_company_headcount` accumulates monthly rows; the company page Momentum section stops
  self-hiding.

## Stage 4 — fan-out (the alerts substrate)

Flip: `SIGNAL_FANOUT_ENABLED=true`.
- First tick initialises the watermark at NOW and delivers NOTHING — expected, that is the alert-storm
  defence, not a fault. Signals recorded after the flip fan out on the next 15-min tick.
- Verify: `SELECT count(*) FROM tenant_signals;` grows for workspaces holding bridged accounts; the
  `/signals` page feed renders; a user subscribed on a watchlist gets an `account_signal` notification
  for a fresh delivery (and ONLY a subscribed user — dispatch is opt-in).

## Stage 5 — job-change alerts (S-13)

Flip: `JOB_CHANGE_SWEEP_ENABLED=true`. Same watermark-init behavior as stage 4. Verify: a Layer-0
employment move on a saved contact produces the tenant signal + the notification to users who saved it.

## Stage 6 — account scoring

Flip: `ACCOUNT_SCORING_ENABLED=true`.
- Verify: accounts receiving signals get `account_scores` rows (`model_version='v1'`, breakdown
  populated) and `accounts.icp_fit_score` moves (the trigger cache = FIT, not composite).

## Stage 7 — market rollups + board

Flip: `MARKET_ROLLUPS_ENABLED=true`.
- Verify: the daily sweep logs `market rollup sweep: rebuilt {rows, runtimeMs}`;
  `GET /api/v1/market/segments` flips to `enabled:true`; `/companies/markets` renders.
- Standing watch (the written revisit trigger, 06 §4): `runtimeMs > 15min` or board p95 > 1s for two
  consecutive weeks → open the columnar-store evaluation. The log line exists for exactly this.

## Stage 8 — policy-driven badge constants (display-only, announce first)

Flip: `CONFIDENCE_POLICY_BADGE_ENABLED=true` — the C9 unification. Badge decay re-prices off
`master_confidence_policy` half-lives; documented band movement is 0.09–0.17 on some records, so
**announce before flipping** (D-2's condition). Per-row `is_enabled` underneath allows field-by-field
rollout; a policy-read failure silently falls back to the hardcoded constants (a reveal can never fail
on this).

## Blocked stages (do not improvise)

- **Funding ingest** — D-4 procurement. When a feed is licensed: `provider_configs` clearance → vendor
  adapter (`VendorSpec` + `ALLOWED_PROVIDER_HOSTS`) → writer already exists
  (`masterCompanyDetailRepository` funding upsert + `funding` signal emission).
- **Technographics** — D-5 + C4 GPL clearance. Catalog seed must be license-clean; adoptions writer path
  per `masterTechnologyAdoption.ts` §6.5.
- **Job postings** — D-6 procurement. `masterJobPostingsRepository.upsertPosting` is ready; the parser
  MUST strip person data before landing (08 §1 — the table has no contact columns by design).
- Inventing a source to fill any of these is exactly the "collection beyond user-initiated actions" hard
  constraint 4 forbids.

## Kill order (full rollback)

Reverse of enablement. Any single stage can be killed alone; downstream stages degrade to honest
empties. Watermarks persist in Redis across a kill/re-enable — a re-enable resumes from the stored
watermark; a Redis loss re-initialises at NOW and misses the gap rather than storming (the deliberate
failure direction, documented in each sweep header).
