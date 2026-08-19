# 00 — Implementation progress (living doc, updated per work session)

Roadmap: [09-roadmap-and-decisions.md](09-roadmap-and-decisions.md). Ratification:
`docs/strategy/decisions.md` 2026-08-19 entry (D-1 ratified; D-2/D-8/D-9 defaults
adopted; D-4/D-5/D-6/D-3-final still open — procurement/commercial).

| Item | Phase | Status | Notes |
|---|---|---|---|
| D-1 ratification recorded | MI-P0 | ✅ 2026-08-19 | decisions.md entry |
| Leadership-signal emitter (`exec_hired`/`exec_departed` in `landSourcePayload` step 8) | MI-P1 | ✅ built | company-subject, transition-guarded, evidence-idempotent; itest 3+4 extended |
| C9 confidence unification (D-2 default) | MI-P0 | ⬜ next | badge leaf fn + policy-table constants, display-only |
| MI-S6 `tenant_signals` + `signal_fanout` worker | MI-P1 | ⬜ | |
| MI-S5 watchlists + subscriptions + `alert_dispatch` | MI-P2 | ⬜ | |
| MI-1 `/companies` destination + IA regroup | MI-P1 | ⬜ | after fan-out so page has tenant signal feed |
| MI-S3 industry taxonomy + alias backfill | MI-P5 | ⬜ | |
| MI-S4 `account_scores` + scoring worker | MI-P5 | ⬜ | |
| MI-S7 `market_rollups` + boards | MI-P5 | ⬜ | |
| MI-S1 `job_postings` schema (producer blocked on D-6 feed) | MI-P4 | ⬜ | schema + dark reader only until feed |
| Funding ingest | MI-P3 | ⛔ blocked D-4 | writer exists, no source |
| Technographics seed + feed | MI-P3 | ⛔ blocked D-5/C4 | |
| Enablement runbook (MI-9) | parallel | ⬜ | env flips are deploy-side, not repo-side |

Update discipline: shipped-code-wins; every divergence from docs 04–07 gets a row
here, not a silent doc edit.
