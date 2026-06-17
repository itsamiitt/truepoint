# ADR-0015 — Entity resolution / deduplication engine (Splink)

- **Status:** Accepted
- **Date:** 2026-06-02
- **Context doc:** [03-database-design.md](../03-database-design.md), [06-enrichment-engine.md](../06-enrichment-engine.md)
- **Amended by:** [ADR-0021](./ADR-0021-global-master-graph-and-overlay.md) (2026-06-09) — entity resolution is now **global / cross-source** at the master-graph layer (deterministic keys → **blocking + MinHash/LSH** candidate generation → **Splink** scoring → survivorship), not within-workspace only. The within-workspace Splink dedup below still applies to the **overlay**; the engine choice (Splink) is unchanged.

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

**Import-path gap (G-ER-2).** The original decision wired Splink into the **async DQ batch** only; the
**import path** still relies on exact-key unique indexes alone. At million-row CSV scale that is not
enough (cross-source research summary, [../30-bulk-import-export-pipeline.md](../30-bulk-import-export-pipeline.md)):

- A single uploaded file routinely contains **near-duplicate rows of its own** (same person re-exported
  with formatting drift, partial fields, a stale title) that share **no exact key** — so unique indexes
  let them all through as distinct records.
- A default workspace import never enters Layer-0 global resolution, so the **fuzzy tail against the
  workspace's existing data** is never resolved at import time — only the exact-key first line runs.
- When a fuzzy match *is* found, an **irreversible auto-merge with no survivorship rules destroys good
  values** (overwrites a verified email with a blank, a current title with a stale one).
- Duplicate review is **staff-only** ([13](../13-platform-admin.md), [22 §6](../22-data-quality-freshness-lifecycle.md)),
  so a **customer importing their own list** cannot resolve the dupes it created in their overlay (G-ENR-6).

## Decision

Adopt **Splink** (MIT-licensed probabilistic record linkage, Fellegi-Sunter model) as the
**within-workspace entity-resolution / dedup engine** that powers `dedupe_candidates` in the
data-quality subsystem ([06 §9](../06-enrichment-engine.md), [03 §14](../03-database-design.md)). It runs
as a **batch job** (on the workers / AWS Batch) over a workspace's `contacts`/`accounts`, produces
candidate duplicate clusters with **match probabilities**, and `is_duplicate_of` links the survivor.
Exact-match dedup at import (unique indexes) stays the **first line**; Splink resolves the **fuzzy tail**.
**No cross-workspace / global resolution** ([ADR-0006](./ADR-0006-per-workspace-multitenant-model.md)).

### Import-path dedup (extends ER to bulk CSV — closes G-ER-2)

Bulk CSV import ([../30-bulk-import-export-pipeline.md](../30-bulk-import-export-pipeline.md),
[ADR-0036](./ADR-0036-bulk-async-job-and-staging-pipeline.md)) runs **two dedup passes** in the staging
job **before** rows land in the overlay — exact-key unique indexes alone are insufficient at million-row scale:

1. **Within-file (intra-batch) dedup.** Collapse rows of the *same upload* by **normalized natural key**
   (lower-cased/trimmed email blind index, or normalized name + registrable company domain when email is
   absent). Collapsed rows merge into **one staged record** using the survivorship rules below — keeping the
   **most-complete and most-recent** field values — rather than letting unique indexes pick an arbitrary
   winner or rejecting later rows. This happens in-job over the staged batch, **not** as a DB constraint.

2. **Overlay fuzzy dedup (not just exact-key).** Each surviving staged record is matched against the
   workspace's **existing** `contacts`/`accounts`, reusing the **Layer-0 blocking keys** (deterministic keys
   → blocking/MinHash-LSH candidate generation → **Splink** scoring; [ADR-0021](./ADR-0021-global-master-graph-and-overlay.md))
   so the overlay no longer dedups on exact keys alone. This brings the fuzzy tail to the **import path**,
   which default imports never entered before.

**Company matching** (both passes) keys on **name + normalized domain**: the registrable domain (eTLD+1 of
the email/website, `primary_domain`/`alt_domains` at Layer 0) is the strong signal; the normalized company
name is the fuzzy fallback. This mirrors the master-graph employment-edge resolution
([ADR-0021](./ADR-0021-global-master-graph-and-overlay.md)) so import and global ER agree on what "same company" means.

**Per-attribute survivorship (which field wins).** A fuzzy merge (within-file *or* overlay) **never**
overwrites blindly — each field is decided independently by, in order: **source priority** (verified
provider/master channel > user import > inferred), then **recency** (most-recently-verified value),
then **completeness** (a present value beats a blank). An **irreversible auto-merge without survivorship
destroys good values**, so survivorship is a precondition for any auto-merge and every merge records the
field-level decisions for audit/un-merge.

**Calibrated two-threshold routing.** Splink match scores route through **two calibrated thresholds**
(Fellegi-Sunter): **auto-accept** (≥ high cutoff → survivorship-merge), **clerical-review** (between cutoffs
→ duplicate-review queue), **auto-reject** (< low cutoff → treat as distinct). Thresholds are **tuned against
a reviewed sample** to hit the precision/recall targets, **not** hard-coded; the calibration method, the
`data_quality_rules` storage, and the ER precision (≥ 0.95) / false-merge (≤ 0.5%) targets are owned by
[22 §5–§6](../22-data-quality-freshness-lifecycle.md) — this ADR consumes them.

**Customer-facing duplicate-review queue (closes G-ENR-6).** Clerical-review pairs surface to the
**customer** in their workspace (suggested pairs from `is_duplicate_of`, field-pick survivorship, reversible
un-merge, audited) — **not staff-only**. The staff merge/unmerge console ([13](../13-platform-admin.md),
[22 §6/§8](../22-data-quality-freshness-lifecycle.md)) remains for Layer-0/global review; the new queue lets a
customer resolve the fuzzy dupes inside **their own overlay**, including those an import created. Per-import
conflict policy (`skip_existing`/`overwrite`/`fill_empty_only`/`route_to_review`, G-IMP-5) and duplicate-sensitivity
([29](../29-settings-administration-architecture.md)) select how aggressively imports route to it.

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

- **Positive:** real probabilistic ER with match scores; MIT licence; scales laptop→cluster; gives risk #1 a concrete mitigation. The import path now does **two-pass dedup** (within-file + overlay fuzzy), survivorship protects good values on every merge, and customers can resolve their own fuzzy dupes (closes G-ER-2, G-ENR-6).
- **Negative:** batch (not real-time) matching; adds a pipeline + model-tuning surface; another dependency. Within-file collapse + overlay fuzzy matching add **per-import compute** to the staging job, and a customer-facing review queue is **new UI + audit surface** to build and staff-SLA.
- **Mitigation:** exact-match unique indexes catch the common case **synchronously at import**; the within-file/overlay fuzzy passes run **in the async staging job** ([ADR-0036](./ADR-0036-bulk-async-job-and-staging-pipeline.md)), not on the upload request; **calibrated** thresholds keep auto-accept precise (≥ 0.95) and shunt the uncertain middle to review rather than auto-merging; surfaced to customers via Data Health + the new overlay review queue and to staff via the admin DQ console ([13](../13-platform-admin.md), [22 §6/§8](../22-data-quality-freshness-lifecycle.md)).

## Revisit if

Real-time or **cross-source/global** identity resolution at scale becomes a requirement (re-evaluate
Senzing, and note that global resolution would reopen [ADR-0006](./ADR-0006-per-workspace-multitenant-model.md)).
**→ Triggered (2026-06-09): [ADR-0021](./ADR-0021-global-master-graph-and-overlay.md) makes ER global/cross-source** at the master-graph layer (blocking + LSH + Splink at billions; Senzing reconsidered for real-time ER as a future option). This reopened ADR-0006 as designed.
