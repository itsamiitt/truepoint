# ADR-0008 — Lead-scoring & intelligence model

- **Status:** Accepted
- **Date:** 2026-05-29
- **Context doc:** [03-database-design.md](../03-database-design.md), [06-enrichment-engine.md](../06-enrichment-engine.md)

## Context

The multi-tenant proposal adds an intelligence layer with no prior governing decision: versioned `scores` (icp_fit / intent / engagement / composite + `score_breakdown` jsonb) and weighted `intent_signals`, with a trigger syncing `contacts.priority_score` to the latest composite.

A naming hazard must be settled up front: LeadWolf previously used "confidence" for **data correctness** (how sure we are a field is right). The new "score" is **prospect quality** (how good a lead is). These are different concepts and must not collide.

## Decision

- **Lead score = prospect quality**, workspace-scoped and customer-private. Stored in `scores` as a versioned history (each re-score inserts a new row); `intent_signals` feed the intent component with a `weight` (1–10) and a typed `signal_type`.
- **`contacts.priority_score`** is a denormalized cache of the latest `scores.composite_score`, maintained by an `AFTER INSERT ON scores` trigger.
- **Lead score is explicitly distinct from data confidence.** Under the per-workspace model ([ADR-0006](./ADR-0006-per-workspace-multitenant-model.md)) the global field-level data-confidence model was removed; what remains is per-import source trust recorded in `source_imports`. Docs must use "lead score / priority" for quality and reserve "verification/validity" (e.g. `email_status`) for correctness.
- **Scoring is workspace-private** (two workspaces can score the same person differently) and is **not** a billable reveal event.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| Versioned scores + typed intent signals (this ADR) | Chosen | Matches the proposal; preserves score history for auditing model changes. |
| Single mutable score column | Rejected | Loses history; can't explain why a score changed. |
| Fold scoring into the old data-confidence model | Rejected | Conflates prospect-quality with field-correctness. |

## Consequences

- **Positive:** explainable, versioned scoring; clear separation from data correctness; per-workspace tunability.
- **Negative:** `scores` grows quickly (every re-score) → time-partition it ([03 §12](../03-database-design.md#12-partitioning--scale-100m)); the sync trigger couples `scores` writes to `contacts` (kept tiny/idempotent).
- **AI tie-in:** the AI/ICP features in [05 §16](../05-features-modules.md) compute against this model; NL-search ranking can use these scores.

## Revisit if
Scoring needs to be shared/standardized across workspaces, or model versioning needs first-class A/B evaluation — introduce a scoring-model registry.
