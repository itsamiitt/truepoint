# ADR-0025 — Data freshness, decay & re-verification lifecycle

- **Status:** Accepted
- **Date:** 2026-06-10
- **Context doc:** [22-data-quality-freshness-lifecycle.md](../22-data-quality-freshness-lifecycle.md), [06-enrichment-engine.md](../06-enrichment-engine.md)

## Context

B2B contact data decays fast (job changes, company moves), yet the corpus leaves freshness as open
questions: `06 §9` flags "periodic re-verification" and a "freshness SLA" with no cadence, `03 §13/§14`
list `verification_jobs`/`data_quality_rules` as *planned*, and the `data_quality_score` formula is named
but undefined. Without a freshness policy the data ages, the **charge-only-for-valid + credit-back**
promise ([ADR-0013](./ADR-0013-charge-for-verified-data-credit-back.md)) erodes, and we have no coverage
or match-rate targets to defend quality.

## Decision

Adopt a quantified **freshness & lifecycle policy** (detail in
[22](../22-data-quality-freshness-lifecycle.md)).

- **`data_quality_score` (0–100), defined:**
  `round(100 × (0.4·completeness + 0.3·verification + 0.3·freshness))`, each sub-score ∈ [0,1].
  Stored on master golden records and mirrored onto overlay copies; `freshness_status` ∈
  `fresh|aging|stale|expired` is derived from age vs. the field's SLA.
- **Freshness SLAs (re-verify cadence by field):** email `90 days`; mobile/direct phone `180 days`;
  employment/title `60 days`; company firmographics `180 days`; intent signals `rolling 30-day window`.
  Senior/high-value records re-verify on the shorter end first.
- **`verification_jobs`:** scheduled re-verify/re-enrich driven by `last_verified_at` + SLA + priority
  (recently-revealed and high-`data_quality_score`-decay records first), executed on AWS Batch/workers,
  cost-budgeted and metered like enrichment (`06 §5/§6`).
- **Decay & purge:** a decay model lowers `freshness` as age approaches the SLA; records beyond a
  retention window and unused are flagged for purge under the storage-limitation policy (`08 §7`).
- **Coverage / match-rate targets (defended, not guaranteed in prose):** tracked on the economics/Data
  Health dashboards (`06 §10`, `22`) — email-coverage, phone-coverage, waterfall fill-rate, and ER
  match/false-merge rates — each with an internal target and alert threshold.
- **ER quality:** documented blocking-rule + Splink match-threshold tuning per dataset and a
  **manual-review queue** for low-confidence merges (`22`, resolves `03 §13 Q3`,
  [ADR-0015](./ADR-0015-entity-resolution-dedup-engine.md)/[ADR-0021](./ADR-0021-global-master-graph-and-overlay.md)).

## Rationale

A concrete formula + per-field cadence makes quality testable and keeps the credit-back promise honest.
Prioritizing re-verification by decay and recent use spends verification budget where it matters. Targets
+ alert thresholds give Ops a defendable quality bar versus incumbents.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Quantified freshness SLAs + scheduled re-verify (this ADR)** | Chosen | Keeps data deliverable + credit-back honest; testable. |
| Verify only on reveal | Rejected | Data ages after reveal; bounce/credit-back cost rises; stale exports. |
| Re-verify everything on a fixed clock | Rejected | Wasteful; ignores decay/priority; cost-unbounded. |

## Consequences

- **Positive:** deliverable data; defensible coverage/quality; lower bounce/credit-back cost; a freshness
  product differentiator (`15`, `22`).
- **Negative:** ongoing verification spend; scheduler + review-queue to build; storage churn.
- **Mitigation:** priority queue + budgets + caching; coverage/cost dashboards; tune SLAs from measured
  decay.

## Revisit if

Measured decay differs materially from these SLAs, or verification cost outweighs the bounce/credit-back
savings — then re-tune cadences per field/segment.
