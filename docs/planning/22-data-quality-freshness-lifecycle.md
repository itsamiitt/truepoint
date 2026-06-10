# 22 — Data Quality, Freshness & Lifecycle

> How data stays **correct and current** after it enters: the `data_quality_score` formula, per-field
> **freshness SLAs** + decay, scheduled re-verification, coverage/match-rate targets, entity-resolution
> quality + manual review, and retention/purge.
> [ADR-0025](./decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md) locks the policy;
> downstream of acquisition ([21](./21-data-acquisition-sourcing.md)) and enrichment ([06](./06-enrichment-engine.md)).

## 1. Principles

- **Correctness ≠ lead quality.** `email_status`/`phone_status`/`data_quality_score` measure *field
  correctness*; lead score (`ADR-0008`) measures *prospect quality*. Never conflate (`06 §1`).
- **Decay is real.** B2B data ages; freshness is a first-class, measured property, not an afterthought.
- **Spend where it matters.** Re-verification is **prioritized** by decay + recent use, under budget.

## 2. `data_quality_score` (0–100), defined

`data_quality_score = round(100 × (0.4·completeness + 0.3·verification + 0.3·freshness))`, each
sub-score ∈ [0,1]:

- **completeness** = share of expected fields present (name, title, company, email, phone, …, weighted).
- **verification** = correctness from `email_status`/`phone_status` (`valid`=1, `catch_all/unknown`=0.5,
  `invalid`=0).
- **freshness** = decayed by age vs. the field's SLA (§3).

Stored on master golden records and **mirrored** onto overlay copies ([03 §5](./03-database-design.md)); it
drives Data Health (§8), re-verify priority (§4), and is surfaced to users as a badge (`05`, `11 §4.5`).

## 3. Freshness SLAs, `freshness_status` & decay

| Field | Re-verify SLA |
|---|---|
| Email | 90 days |
| Mobile / direct phone | 180 days |
| Employment / title | 60 days |
| Company firmographics | 180 days |
| Intent signals | rolling 30-day window |

`freshness_status` ∈ `fresh|aging|stale|expired` derives from `age / SLA` (e.g. `<0.5`=fresh,
`<1.0`=aging, `<1.5`=stale, else expired). The **decay model** lowers the `freshness` sub-score
continuously as age approaches the SLA, so quality degrades gracefully rather than at a cliff.

## 4. Scheduled re-verification (`verification_jobs`)

- **`verification_jobs`** ([03 §14](./03-database-design.md)) schedules re-verify/re-enrich driven by
  `last_verified_at` + SLA + **priority** (recently-revealed, high-decay, high-`data_quality_score`-drop
  records first), on AWS Batch/workers, cost-budgeted + metered like enrichment (`06 §5/§6`).
- A completed run emits `verification.completed` (`20`) → updates status, Data Health, and **credit-back**
  on confirmed bounces (`H13`, [ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md)).
- **`data_quality_rules`** ([03 §14](./03-database-design.md)) hold validation + freshness thresholds +
  confidence cutoffs as data, so policy tunes without code.

## 5. Coverage & match-rate targets (defended, tracked)

Internal targets with alert thresholds on the economics/Data-Health dashboards (`06 §10`) — defended, not
promised verbatim in customer prose:

| Metric | Initial target |
|---|---|
| Email coverage (verified) by day 30 post-import | ≥ 80% |
| Direct/mobile phone coverage | ≥ 50% |
| Waterfall cumulative email fill-rate | ≥ 85% |
| ER match precision (golden merges) | ≥ 0.95 |
| ER false-merge rate | ≤ 0.5% |

Breaching a threshold pages Ops (`13`, `19 §3`) and triggers provider/registry/contribution fill (`21 §8`).

## 6. Entity-resolution quality & manual review

- **Tuning:** documented blocking rules + Splink match-threshold per dataset (resolves `03 §13 Q3`,
  [ADR-0015](./decisions/ADR-0015-entity-resolution-dedup-engine.md)/[ADR-0021](./decisions/ADR-0021-global-master-graph-and-overlay.md)).
- **Manual-review queue:** low-confidence merges route to a staff review queue (`13`) with a merge/unmerge
  UI and an audit trail; survivorship decisions are explainable.
- **Overlay dedup** stays within-workspace on blind-index keys (`H4`); global ER is at Layer 0.

## 7. Retention & purge

- Records beyond the storage-limitation window and **unused** are flagged for purge (`08 §7`); suppression
  + DSAR deletions fan out across copies (`H6`).
- Purge respects legal holds and the lawful-basis lineage (`21 §5`); everything is audited (`08 §5`).

## 8. Data Health surfaces

- **Customer-facing** Data Health (Reports, `11 §4.5`): verification status, freshness, duplicates,
  `data_quality_score` distribution per workspace.
- **Staff** Data-Ops (`13`): coverage/match-rate trends, ER review queue, verification-job throughput,
  provider quality.

## Links
- **Links to:** [03 §5/§14](./03-database-design.md), [06 §9/§10](./06-enrichment-engine.md),
  [08 §7](./08-compliance.md), [07 §3](./07-billing-credits.md), [13](./13-platform-admin.md),
  [20](./20-event-driven-realtime-backbone.md), [21](./21-data-acquisition-sourcing.md), [10](./10-roadmap.md),
  [ADR-0025](./decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md),
  [ADR-0015](./decisions/ADR-0015-entity-resolution-dedup-engine.md)
- **Linked from:** [00 §7](./00-overview.md#7-decision-log), [06 §9](./06-enrichment-engine.md), [03 §14](./03-database-design.md), README

## Open questions
1. Sub-score weights (0.4/0.3/0.3) and decay curve shape — tune from measured decay.
2. Re-verify budget per plan tier (how aggressive by default) — `07`/`12`.
3. Manual-review SLA + staffing for low-confidence merges — `13`.
