# Market Intelligence — making TruePoint a combined Sales + Market intelligence product

**Series:** `docs/planning/market-intelligence/` · **Status:** planning complete, implementation not started
**Date:** 2026-08-18 · **Outcomes served:** [S-02][S-09][S-10][S-13][A-01] (per-doc tags below)

## What this series is

A full-app scan (web, admin, api, workers, db, forge, extension, integrations) plus a
reconciliation of the strategy + planning corpus, answering one question:

> What has to change for TruePoint to ship as a **sales intelligence AND market
> intelligence** product?

The one-sentence answer the series expands: **the schema is already built and the product
is not** — the intelligence-platform programme (migrations for the technology catalog,
technology adoptions, master signals, funding, headcount, confidence policy) landed the
entire Layer-0 market substrate, and almost every table is empty because no producer
feeds it and no page surfaces it. The work is *population, promotion, and alerting*,
not modelling.

## Succession, not a peer

`docs/planning/intelligence-platform/` already carried the mission "full Sales + Market
Intelligence" and stopped, by its own handover (`10-handover.md` §4), at: *"Phase 8 (the
four profile UIs) is blocked on data, not on UI… Populators are the high-value next
work."* This series is the successor to that handover. It re-plans nothing that series
decided; it cites it. Same posture toward `prospect-company-data/`,
`import-and-data-model-redesign/`, and `docs/strategy/`.

## How to read

| Doc | Contents |
|---|---|
| [01-current-state.md](01-current-state.md) | What exists today, verified against code — shipped, dark, unfed |
| [02-gap-analysis.md](02-gap-analysis.md) | Pillar-by-pillar gap table: schema / producer / API / UI |
| [03-scope-and-constraints.md](03-scope-and-constraints.md) | Non-goals, the X-04 intent boundary, the three unreconciled strategy tensions |
| [04-capability-blueprint.md](04-capability-blueprint.md) | The target capability set, each mapped to outcome IDs |
| [05-data-acquisition.md](05-data-acquisition.md) | Sources per pillar; what plumbing is reused; the licensed-feed decisions |
| [06-architecture.md](06-architecture.md) | Schema deltas (few), producers, fan-out, aggregation seam, confidence unification |
| [07-product-surfaces.md](07-product-surfaces.md) | The `/companies` destination, watchlists/alerts, IA regroup, admin surfaces |
| [08-compliance.md](08-compliance.md) | Per-pillar compliance posture under `docs/strategy/09-compliance.md` |
| [09-roadmap-and-decisions.md](09-roadmap-and-decisions.md) | Phased roadmap with gates + the human decision register |
| [10-enablement-runbook.md](10-enablement-runbook.md) | The deploy-side flag-flip runbook (MI-9): stages, probes, rollback |

## Ground rules this series inherits (binding)

- **Reconcile-and-cite.** Every claim about current state was verified against code on
  branch `feat/data-mgmt-01-research-brief` at the date above; each doc names files.
- **No fixed migration numbers.** Schema work is referenced by step IDs (`MI-S1`, …);
  numbers are taken at PR time (`import-and-data-model-redesign/README.md` rule).
- **Outcome tags on everything.** Work serving no listed outcome is flagged, not built
  (CLAUDE.md rule 1). Where this series proposes work ahead of the strategy's stated
  sequencing, doc 03 says so explicitly instead of silently reinterpreting (rule 6).
- **Dark by default.** Every new path ships behind an env kill-switch, per-tenant flag
  where user-visible, flag-off byte-identical.
- **Rule 6 ratification needed.** "Market intelligence as a named product surface" is a
  strategy change (the roadmap's own words defer the rescore to post-Phase-6). The
  decision register in doc 09 lists what a human must ratify in
  `docs/strategy/decisions.md` before build starts.
