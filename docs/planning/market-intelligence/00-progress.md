# 00 — Implementation progress (living doc, updated per work session)

Roadmap: [09-roadmap-and-decisions.md](09-roadmap-and-decisions.md). Ratification:
`docs/strategy/decisions.md` 2026-08-19 entry (D-1 ratified; D-2/D-8/D-9 defaults
adopted; D-4/D-5/D-6/D-3-final still open — procurement/commercial).

| Item | Phase | Status | Notes |
|---|---|---|---|
| D-1 ratification recorded | MI-P0 | ✅ 2026-08-19 | decisions.md entry |
| Leadership-signal emitter (`exec_hired`/`exec_departed` in `landSourcePayload` step 8) | MI-P1 | ✅ built | company-subject, transition-guarded, evidence-idempotent; itest 3+4 extended |
| C9 confidence unification (D-2 default) | MI-P0 | ✅ built | `ConfidenceHalfLifePolicy` param on the leaf fn; `masterConfidencePolicyRepository.loadBadgeHalfLives` + gated cached loader (`badgeHalfLifePolicy`); wired into reveal badge + provenance route; dark behind `CONFIDENCE_POLICY_BADGE_ENABLED` |
| MI-S6 `tenant_signals` + `signal_fanout` worker | MI-P1 | ✅ built | migration 0125 + RLS, census/projection repos, core `fanoutSignalsToWorkspace`, leader-locked sweep dark behind `SIGNAL_FANOUT_ENABLED`; itest 4/4 (routing, delivery, idempotency, RLS) |
| MI-S5 watchlists + subscriptions + dispatch | MI-P2 | ✅ built (backend + API) | migration 0126 + RLS; `watchlistRepository` (CRUD, members, subscribe, `subscribersFor`); dispatch inside `fanoutSignalsToWorkspace` → `account_signal` notifications, fresh-rows-only dedup; itest 5/5. API: `/api/v1/watchlists` CRUD+members+subscription, `GET /api/v1/signals` feed (`apps/api/src/features/alerts/`). Web UI still owed |
| Signals web destination (`/signals` feed + watchlists UI) | MI-P2 | ✅ built | `apps/web/src/features/signals/`, rail entry, `account_signal` notification deep-links; honest empty states while dark |
| MI-1 `/companies/:id` routed page | MI-P1 | ✅ built | `features/companies/` + `GET /api/v1/accounts/:id` (`getMaskedById`, search's SELECTION); reuses prospect sections via barrel; Watch toggle ("Watched accounts" auto-list); drawer + signal rows deep-link |
| MI-1 `/companies` index destination | MI-P1 | ✅ built | `CompaniesIndexPage` reusing the URL-driven account-search engine + filter rail + grid; rail entry (Building2); row → routed page; `contactsHrefForCompany` deep-link builder. **Toggle cutover still owed**: retire Prospect's Contacts⇄Accounts SegmentedControl with `?scope=accounts` redirects |
| Subscription hydration (`myFamilies` on GET /watchlists) | MI-P2 | ✅ built | repo LEFT JOIN, schema field, UI hydrates server truth |
| MI-S3 industry taxonomy | MI-P5 | ✅ built (v1) | 0128: `master_industries` two-level tree (15 sectors + 9 subsectors) + `master_industry_aliases` (citext; label self-aliases + ~45 vendor spellings) + `industry_id` on master_companies/accounts + migration-time backfill; landing resolves new rows (4a′ in landCompany); app+er SELECT grants. Itest asserts "Hospitals and Health Care" → providers-hospitals. Still owed: account-side rollup of master industry_id → accounts (bridge sweep), facet-by-node in account search |
| MI-S4 `account_scores` + scoring worker | MI-P5 | ✅ built | 0129 + RLS + fit-cache trigger (name-honest: cache = FIT); `computeAccountScore` (pure `accountIcpFit`/`accountMomentum` unit-pinned 7/7; company facts only — no intent inputs); event-driven `account_scoring_sweep` dark behind `ACCOUNT_SCORING_ENABLED`; itest 6/6 incl. trigger-cache proof |
| MI-S7 `master_market_rollups` + sweep + API | MI-P5 | ✅ built (backend) | 0130 (non-PII segment cache, dims = account-search facets so numbers reconcile with drill-down); owner-conn rebuild (the argued no-rollup departure + revisit trigger logged per tick); daily sweep dark behind `MARKET_ROLLUPS_ENABLED`; `GET /api/v1/market/segments` honest-empty while dark; itest 3/3 (aggregation, idempotent rebuild, app-role denial). Board web UI still owed |
| MI-S1 `master_job_postings` schema + reader | MI-P4 | ✅ built | migration 0127 (HASH(company)×32, the 0114 pattern), er-grant + partition-ACL, `masterJobPostingsRepository` (upsert-in-place writer ready for the D-6 feed, open-list + by-dept reads), `GET /accounts/:id/postings`, self-hiding `PostingsSection` on the company page; itest 3/3 incl. app-role denial on parent AND partition. **Producer stays blocked on D-6** |
| Funding ingest | MI-P3 | ⛔ blocked D-4 | writer exists, no source |
| Technographics seed + feed | MI-P3 | ⛔ blocked D-5/C4 | |
| Enablement runbook (MI-9) | parallel | ⬜ | env flips are deploy-side, not repo-side |

Update discipline: shipped-code-wins; every divergence from docs 04–07 gets a row
here, not a silent doc edit.
