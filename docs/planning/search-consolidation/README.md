# Search Consolidation

> **Status: SHIPPED — stages 1–5 landed 2026-08-21. Amended 2026-08-25** (`docs/strategy/decisions.md`):
> the reveal IS the save gesture (no "Add to workspace" anywhere in `apps/web`), the profile gate
> `DATABASE_PROFILE_ENABLED` was removed, and the rail became two tiers (quick filters + "All filters").
> Where a paragraph below says otherwise, the dated **Superseded** note beside it wins.
> Operator decision 2026-08-21. Partially reverses D-9 (`docs/strategy/decisions.md`,
> 2026-08-19).

Rebuild the Prospect surface into a single **Search** destination: a collapsible
filter drawer with People and Accounts tabs, both searching the global TruePoint
database, with full profiles readable without adding a record to the workspace first.

| Doc | Contents |
|---|---|
| [`00-decision-and-scope.md`](./00-decision-and-scope.md) | The operator decision, what it reverses, scope boundaries, the four populations |
| [`01-frontend-spec.md`](./01-frontend-spec.md) | Routes, component tree, the drawer, tabs, filter UX, results grid, profile drawers, states, query keys |
| [`02-backend-spec.md`](./02-backend-spec.md) | The `leadwolf_app` role wall and what it forces, endpoints, Zod contracts, repositories, `MASTER_COMPANY_VISIBLE`, keyset pagination + the filtered-keyset correction, counts, caching, rate limits, observability |
| [`03-migration-and-index-plan.md`](./03-migration-and-index-plan.md) | `0134` / `0135` / `0136`, the citext trgm trap, the `'-infinity'` sentinel hazard, rollback, `EXPLAIN ANALYZE` verification |
| [`04-permission-changes.md`](./04-permission-changes.md) | Every new authorization surface, every line NOT crossed, the enumeration threat, the compliance assessment |
| [`05-rollout-and-risks.md`](./05-rollout-and-risks.md) | Pre-build reasoning summary, R1–R10, feature gates, the five build stages, testing, the removal-cleanup grep sweep, the enrichment roadmap, the `decisions.md` draft |

## The three things a reviewer should check first

1. **R1 — how populated is the global database?** **Measured 2026-08-21, no longer
   blocking:** 176 sellable people, 231 landed companies, first landing four days ago,
   growing ~100 rows/day, ingestion throttled (`http 429`) but working. The census
   table is in `05`. It corrected the company visibility predicate — see below.
2. **`04-permission-changes.md`** — this makes Layer-0 person records readable to more
   authenticated users. Channel values stay paid and no workspace-overlay fact is
   served, but the compliance table there is the rule-3 stop-and-ask point.
3. **The `decisions.md` draft in `05`** — reversing a ratified decision is a recorded
   act, not a silent one (rule 6).

## What already exists (do not rebuild)

Phase 0 found the Prospect surface is already a real sales-intelligence search:
faceted sidebar with accordion groups and count badges, server-side typeahead,
include/exclude per term field, live facet counts, keyset pagination, URL-synced
shareable filter state, saved and recent searches, bulk select and bulk actions, CSV
export, column chooser, sort, density, quick-view and full record drawers, and an AI
natural-language filter compiler.

The genuine gaps are: the collapsible drawer, the rename, the **global company**
search (a whole new vertical slice — `/api/v1/account-search` is workspace-only), the
global **profile** read surface, the workspace-status filter, and richer filters on
the global contracts.
