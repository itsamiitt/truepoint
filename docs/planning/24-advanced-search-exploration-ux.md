# 24 — Advanced Search & Exploration UX

> The Apollo/ZoomInfo-grade exploration surface in depth: a faceted **filter rail**, **instant** masked
> search, **saved searches/views**, **dynamic segments**, a high-performance grid, and result→action
> flows. Deepens [04 §5](./04-ui-ux-design.md) / [05 §6/§8](./05-features-modules.md) / [11 §4.2](./11-information-architecture.md);
> runs on `SearchPort` (Typesense overlay + OpenSearch global, [ADR-0021](./decisions/ADR-0021-global-master-graph-and-overlay.md)).

## 1. Principles

- **Instant & masked.** Results stream as you filter; PII stays masked (`••••`) until a paid reveal
  (`H1`). Latency targets per [18 §2](./18-scalability-performance.md) (search p95 200 ms).
- **Explorable.** Every facet shows live **counts**; refinement is one click; nothing requires a page hop
  (the single-page model, `11 §1`).
- **High-performance at scale.** Virtualized grid, cursor pagination (never deep offset, `09 §1`), facet
  counts from ClickHouse at billions (`03 §12`).

## 2. The filter rail (faceted sidebar)

Left rail of the Prospect surface (`11 §4.2`). Facet interactions:

- **Multi-select** chips per facet with include/exclude (e.g. title **is** / **is not**).
- **Searchable inputs** for large value sets (company, industry, technology, location).
- **Ranges** (headcount, revenue, founded, lead score, `data_quality_score`, signal recency).
- **Boolean logic:** AND across facets; OR **within** a facet; advanced groups for `(A AND B) OR C`.
- **Preset/use-case bundles** ("EU fintech decision-makers", "recently funded + hiring") one-click apply.
- **Recent searches** + suggested refinements; clear-all; active-filter summary bar.

## 3. Facet catalog

| Group | Facets |
|---|---|
| **Person** | name, title, seniority, department/function, has-email, has-phone, `email_status`, location, timezone, job-change recency |
| **Company** | name, domain, headcount, revenue, industry, sub-industry, location, founded, type |
| **Technographic** | technologies installed/removed (BuiltWith/HG, `06 §2`) |
| **Intent** | `signal_type` fired + recency + strength (Bombora/G2/6sense) — **filterable**, not just shown |
| **Engagement / state** | `outreach_status`, list membership, owner, **assigned team** (`H18`), last activity |
| **Quality** | lead score, `data_quality_score`, `freshness_status` (`22`) |

Intent + technographic + data-quality as **first-class filters** is a gap closed vs. the prior plan
(`05 §6`).

## 4. Instant search & performance

- Debounced (~150 ms) queries via `SearchPort`; skeleton rows during fetch (latency honesty, `04 §5`).
- Facet counts and results stream; **search-sync** keeps the index < 5 s fresh (CDC, `20 §7`).
- Grid is **virtualized** (TanStack Table) with column config + density toggle; cursor pagination.

## 5. Saved searches, views & sharing

- **Saved searches** (`saved_searches`, `05 §8`) persist a filter set, re-runnable, with optional **alerts**
  (notify when new matches appear — ties to automation `27`).
- **Saved views** (`saved_views`) persist column layout + sort + density per user; **shareable** to the
  workspace or a **team** (`H18`) with view/edit scope.
- Manage/reorder/rename/duplicate; a default view per persona (`25`).

## 6. Lists & dynamic segments

- **Static lists** — manually curated (`05 §8`).
- **Dynamic lists** — defined by a saved filter, auto-updating.
- **Smart segments** (`segments`) — dynamic lists with **rules + scheduled refresh** that can drive
  automation (e.g. "enroll new segment members in play X", `27`) and department dashboards (`25`).

## 7. Results grid & bulk actions

- Configurable columns (incl. score, `data_quality_score`, freshness, owner/team); sort; density.
- Sticky **bulk-action bar** (`04 §5`): **reveal(N)** · add-to-list · enroll-sequence · export · push-CRM ·
  assign-owner/team · start-automation — each respecting suppression + entitlements + team budgets.

## 8. From results → action

Reveal (`H1`) → enroll (`ADR-0009`) → export/CRM-push (`26`) → automation (`27`), all from the grid, all
audited (`08 §5`). Masked→revealed transitions update live via SSE (`20 §8`).

## Links
- **Links to:** [04 §5](./04-ui-ux-design.md), [05 §6/§8](./05-features-modules.md), [11 §4.2](./11-information-architecture.md),
  [09 §1/§3.1](./09-api-design.md), [18 §2](./18-scalability-performance.md), [20 §7/§8](./20-event-driven-realtime-backbone.md),
  [25](./25-departments-teams-workspaces.md), [27](./27-workflow-automation-engine.md), [03 §12](./03-database-design.md),
  [ADR-0021](./decisions/ADR-0021-global-master-graph-and-overlay.md)
- **Linked from:** [00 §7](./00-overview.md#7-decision-log), [04 §5](./04-ui-ux-design.md), [05 §6](./05-features-modules.md),
  [11 §4.2](./11-information-architecture.md), README

## Open questions
1. Advanced boolean-group UI depth at MVP vs. M8 (simple AND/OR first).
2. Saved-search alert cadence + dedup (`27`).
3. Cross-workspace ("universe") saved searches over the masked master graph — scope/quota (`09`).
