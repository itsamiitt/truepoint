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

### 2.1 Validation rule set (`data_quality_rules`) — the importer's per-row rules

`data_quality_rules` ([03 §14](./03-database-design.md)) hold the **field-level VALIDATION + normalization**
rules as data (so policy tunes without a deploy). They are the **rule contents** behind the per-row
validation that the bulk-import pipeline runs in its staging pass — the **flow** (parse → map → validate
→ stage → commit, error file, partial-accept) is owned by
[30 §3](./30-bulk-import-export-pipeline.md) ([ADR-0036](./decisions/ADR-0036-bulk-async-job-and-staging-pipeline.md));
this section owns **what each rule checks/normalizes to**. Each rule runs **before** blind-index/`content_hash`
and dedup, so values are normalized identically whether they arrive by import, manual entry, or provider
enrichment (one path — `02 §11`). Per-entity-type rule set:

| Rule | Applies to | Check → normalized form | On failure |
|---|---|---|---|
| **Required fields** | per entity type (§2.2) | a minimal key is present (contact: name **or** email; account: name **or** domain) | row → error file; row rejected, batch continues (partial-accept) |
| **Email — RFC + lowercase** | `email` | RFC-5322 syntax + lowercase + plus-addressing stripped; **MX-able** domain check (DNS), **not** an SMTP/verify probe | invalid syntax → reject field; MX-fail → keep but flag `email_status=unverified` |
| **Phone → E.164** | `phone` | `libphonenumber` parse with import default region → **E.164**; line-type left `unknown` (no validation provider at import) | unparseable → reject field, row keeps other fields |
| **Type coercion + date parsing** | typed/custom columns ([ADR-0028](./decisions/ADR-0028-record-customization-layer.md)) | coerce to the column type; dates parsed with an explicit/declared format → ISO-8601 UTC; numbers/booleans/enums coerced or rejected | uncoercible → field error in the row's error report |
| **URL / domain canonicalization** | `website`, `linkedin_url`, account `domain` | lowercase host, strip scheme/`www`/tracking params; **registrable domain** via the Public Suffix List | malformed → reject field |
| **Country / state normalization** | `country`, `state`/region | map to ISO-3166 alpha-2 (country) + region code via an alias table; casefold | unmapped → keep raw + flag for review |
| **Name / company casing** | `name`, `company`, `title` | trim + canonical casing; company legal-suffix-stripped `name_normalized` ([03 §5](./03-database-design.md)) | n/a (best-effort) |

These mirror the normalization stages used downstream by global ER (`06 §9.1`); validation is the **first
line** and is **synchronous per row**, whereas SMTP email verification and phone line-type validation are
**asynchronous** and run only at reveal/re-verify (§4, `06 §9`) — so an imported field is **unverified**
until that step runs. This closes the rule-contents gap (G-IMP-3); the AI column-mapping/template side of
G-IMP-3 stays with `23 §2`/`29`.

### 2.2 Import-time `data_quality_score` — cold start

A freshly imported, user-supplied value has **no verification confidence yet** (it has not been through the
SMTP/line-type check) and may carry **no observed timestamp**. The §2 formula is computed at import with a
**cold-start** treatment so day-0 score and `freshness_status` are defined rather than undefined:

- **verification (cold start).** Unverified user-supplied values are **excluded** from the verification
  sub-score (they neither earn `1` nor are penalized as `invalid=0`); the sub-score is the **mean over
  fields that carry a real status**. If no field has a status yet, `verification` is **null** and re-weighted
  out — `data_quality_score = round(100 × (0.4·completeness + 0.3·freshness) / 0.7)` — so an unverified
  import is not punished for a check that has not run. The field flips to a real status (and re-enters the
  sub-score) only when verification/enrichment completes (§4).
- **freshness (cold start).** Derived from an **optional user "as-of" date** declared at import (when the
  source export is dated). With an as-of date, age = `now − as_of` against the field SLA (§3); **without**
  one, age is **unknown** and the field starts at `freshness_status = aging` (a conservative mid-band, not
  `fresh`) so unverified imports never masquerade as freshly verified. `last_verified_at` stays **null**
  until a verification run sets it — it is **not** back-filled from the as-of date (which is provenance, not
  verification).
- **completeness** is computed normally from the expected-fields set (§2.3) — it needs no verification.

This makes a day-0 imported record's score honest (high completeness can lift it; absent verification keeps
it from reaching the top band) and closes the cold-start gap (G-DQ-1). Survivorship — which value wins when
the import collides with an existing golden record — is **not** decided here; it is owned by global ER
([ADR-0015](./decisions/ADR-0015-entity-resolution-dedup-engine.md) amended by [ADR-0021](./decisions/ADR-0021-global-master-graph-and-overlay.md), §6).

### 2.3 Expected-fields set + weights, per entity type (resolves OQ1)

`completeness` weights the **expected** fields by value to the product (email/phone carry the most). The set
+ weights are config in `data_quality_rules`, defaulting to:

| Field | Contact weight | Account weight |
|---|---|---|
| Name | 0.10 | 0.10 (company name) |
| Email | 0.30 | — |
| Direct/mobile phone | 0.20 | — |
| Title | 0.10 | — |
| Company / employer | 0.10 | — |
| Domain / website | — | 0.30 |
| Industry | — | 0.15 |
| Employee count / size | — | 0.15 |
| Location (country/region) | 0.10 | 0.15 |
| LinkedIn URL | 0.10 | 0.15 |

Weights sum to 1.0 per entity type; a present-and-valid field earns its full weight, a present-but-invalid
field earns nothing (it failed §2.1). Custom fields ([ADR-0028](./decisions/ADR-0028-record-customization-layer.md))
are **excluded** from completeness by default (workspace-specific, not a universal quality signal).

### 2.4 Bulk (re)computation at a million rows

`data_quality_score` is recomputed as a **set-based** operation, never row-by-row in app code:

- **At import commit**, the cold-start score (§2.2) is written for the whole staged batch in one pass
  ([30 §3](./30-bulk-import-export-pipeline.md), [ADR-0036](./decisions/ADR-0036-bulk-async-job-and-staging-pipeline.md)).
- **After enrichment/verification** completes for a batch, scores are **bulk-recomputed** for the affected
  records in a single `UPDATE … FROM` (or AWS Batch job over the lake at billions, `06 §9`) — verification
  sub-scores now populated, `last_verified_at` set, `freshness_status` recomputed against the SLA. This is
  the same async pathway as scheduled re-verification (§4), so a million-row import's quality "fills in" as
  verification lands rather than blocking the import.
- A nightly/triggered **freshness sweep** recomputes only the `freshness` sub-score set-wide as records age
  across SLA bands (§3), keeping `data_quality_score` and Data Health (§8) current without re-verifying.

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
- **Two calibrated thresholds (the routing ADR-0015 references).** Match scoring uses **two** cutoffs, not
  one yes/no line: an **upper** threshold (`≥` → auto-merge/link) and a **lower** threshold (`<` →
  non-match). Scores **between** them are *possible matches* routed to the manual-review queue below. Both
  cutoffs are **calibrated against a clerically-reviewed labelled sample** by trading **precision vs.
  recall** — the upper threshold is set so review-confirmed precision meets the `≥ 0.95` / false-merge
  `≤ 0.5%` targets (§5), and the **width of the review band** is the lever between human-review cost and
  automated accuracy (tighten it as model calibration improves). Quality is reported as **precision AND
  recall together** against that sample (never a single "accuracy %"), with the active thresholds recorded
  per dataset in `data_quality_rules`.
- **Manual-review queue:** the possible-match band routes to a staff review queue (`13`) with a
  merge/unmerge UI and an audit trail; survivorship — which field value wins on merge — is owned by
  [ADR-0015](./decisions/ADR-0015-entity-resolution-dedup-engine.md)/[ADR-0021](./decisions/ADR-0021-global-master-graph-and-overlay.md)
  (most-recent × most-corroborated × highest-trust source) and is explainable + reversible.
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
  [30 §3](./30-bulk-import-export-pipeline.md) (per-row validation **flow**; this doc owns rule contents),
  [ADR-0036](./decisions/ADR-0036-bulk-async-job-and-staging-pipeline.md),
  [ADR-0025](./decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md),
  [ADR-0015](./decisions/ADR-0015-entity-resolution-dedup-engine.md) (survivorship),
  [ADR-0028](./decisions/ADR-0028-record-customization-layer.md)
- **Linked from:** [00 §7](./00-overview.md#7-decision-log), [06 §9](./06-enrichment-engine.md), [03 §14](./03-database-design.md), [30](./30-bulk-import-export-pipeline.md), README

## Open questions
1. ~~Expected-fields set + weights per entity type (OQ1).~~ **Resolved — §2.3** defines the default
   expected-fields set + weights per entity type (config in `data_quality_rules`). The top-level sub-score
   weights (0.4/0.3/0.3) and decay-curve shape still tune from measured decay.
2. Re-verify budget per plan tier (how aggressive by default) — `07`/`12`.
3. Manual-review SLA + staffing for low-confidence merges — `13`.
4. Default review-band width (gap between the two ER thresholds, §6) before live calibration — set from the
   first reviewed sample.
