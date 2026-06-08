# ADR-0015 — Entity resolution / deduplication engine (Splink)

- **Status:** Accepted
- **Date:** 2026-06-02
- **Context doc:** [03-database-design.md](../03-database-design.md), [06-enrichment-engine.md](../06-enrichment-engine.md)

## Context

Under the per-workspace model ([ADR-0006](./ADR-0006-per-workspace-multitenant-model.md)) dedup is
**within a workspace**. Exact-match dedup at import already works via the unique blind-index constraints
(`(workspace_id, email_blind_index)` / `linkedin_public_id` / `sales_nav_lead_id`,
[03 §5/§11](../03-database-design.md)). But records that arrive from different sources **without a shared
key** — name + account variants, missing/teamed email, formatting drift — need **fuzzy / probabilistic**
matching. The data-quality subsystem ([06 §9](../06-enrichment-engine.md)) referenced only "fuzzy
name+account" with **no named engine**, and **"poor per-workspace dedup quality" is risk #1** in the
register ([10](../10-roadmap.md)). The data-side research
([../../research/sales-intelligence-data-research.md](../../research/sales-intelligence-data-research.md))
recommends a mature open-source entity-resolution library rather than ad-hoc heuristics, and verified two
candidates: **Splink** (MIT, UK Ministry of Justice) and **Zingg** (AGPL-3.0).

## Decision

Adopt **Splink** (MIT-licensed probabilistic record linkage, Fellegi-Sunter model) as the
**within-workspace entity-resolution / dedup engine** that powers `dedupe_candidates` in the
data-quality subsystem ([06 §9](../06-enrichment-engine.md), [03 §14](../03-database-design.md)). It runs
as a **batch job** (on the workers / AWS Batch) over a workspace's `contacts`/`accounts`, produces
candidate duplicate clusters with **match probabilities**, and `is_duplicate_of` links the survivor.
Exact-match dedup at import (unique indexes) stays the **first line**; Splink resolves the **fuzzy tail**.
**No cross-workspace / global resolution** ([ADR-0006](./ADR-0006-per-workspace-multitenant-model.md)).

## Rationale

Splink is **MIT** (permissive — safe to embed in a commercial product, unlike Zingg's AGPL copyleft),
links **~1M records on a laptop in ~1 min** (DuckDB) and **100M+** via Spark/Athena, and is proven in
UK-government production. Probabilistic linkage directly mitigates risk #1 (it replaces "tune
heuristics"). Batch fits the DQ subsystem, which is already async and AWS-Batch-driven
([06 §9](../06-enrichment-engine.md)).

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Splink** (MIT, probabilistic) | Chosen | Permissive licence, laptop-to-100M+ scale, MoJ-proven, fits batch DQ |
| **Zingg** (AGPL, active-learning ML) | Rejected as default | **AGPL copyleft** is a licensing risk for a commercial product; strong tech, viable if ML active-learning is later preferred |
| **Senzing** (commercial, real-time ER) | Rejected | Real-time cross-source ER is overkill + cost for a per-workspace batch dedup need |
| Hand-rolled fuzzy heuristics | Rejected | This is the status quo that produced risk #1 |

## Consequences

- **Positive:** real probabilistic ER with match scores; MIT licence; scales laptop→cluster; gives risk #1 a concrete mitigation.
- **Negative:** batch (not real-time) matching; adds a pipeline + model-tuning surface; another dependency.
- **Mitigation:** exact-match unique indexes catch the common case **synchronously at import**; Splink runs **async** for the fuzzy tail; surfaced to customers via Data Health and to staff via the admin DQ console ([13](../13-platform-admin.md)).

## Revisit if

Real-time or **cross-source/global** identity resolution at scale becomes a requirement (re-evaluate
Senzing, and note that global resolution would reopen [ADR-0006](./ADR-0006-per-workspace-multitenant-model.md)).
