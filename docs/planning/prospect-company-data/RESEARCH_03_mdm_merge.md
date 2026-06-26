# RESEARCH 03 — Multi-Source Merge, Survivorship & Field-Level Provenance

> **Gate:** RESEARCH · **Phase:** 3 — Multi-Source Merge & Provenance Resolution · **Depends on:** the shared
> ground-truth brief for this initiative, [RESEARCH_00](./RESEARCH_00_current_state.md) (the BUILT/PLANNED/UNDESIGNED
> audit — esp. gaps **U1–U4**), [RESEARCH_01](./RESEARCH_01_entity_modeling.md) (the canonical entity model that
> *reserved the field-provenance seam*), [ADR-0021](../decisions/ADR-0021-global-master-graph-and-overlay.md)
> (two-layer model), [ADR-0015](../decisions/ADR-0015-entity-resolution-dedup-engine.md) (Splink + per-attribute
> survivorship), [ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md) (freshness),
> [03 §5.1/§5.2](../03-database-design.md) (the golden + overlay DDL), [06 §9](../06-enrichment-engine.md) (the ER
> pipeline), [22 §5–§6](../22-data-quality-freshness-lifecycle.md) (thresholds + review queue). **Feeds:** the
> Phase-3 BRAINSTORM and PLAN gates. This doc **researches and documents only** — it proposes no schema, writes no
> code, and finalizes no DDL.

---

## 0. Scope, method, and epistemics

This document answers one question: **how should TruePoint merge conflicting multi-source values into a golden
value, and how should it store the per-field answer to "where did this value come from, how confident, as of
when, and can a human override it?"** — the **field-level provenance** gap that [RESEARCH_00 §5/§7.2
U1–U4](./RESEARCH_00_current_state.md) names as the single largest undesigned surface in the initiative
(today provenance is **batch/job-level only**: `source_imports` `contacts.ts:212-245`, `provider_calls`
`intel.ts:88-114`, `enrichment_job_rows.enriched_fields` `enrichmentJobs.ts:131`). [RESEARCH_01](./RESEARCH_01_entity_modeling.md)
established the canonical *shape* (event-sourced log + survivorship-projected golden rows) and **reserved** the
field-provenance seam; this doc researches what fills that seam.

**Epistemic legend.** MDM/data-platform internals are partly proprietary; this doc separates what a vendor
*states* from what is *reasoned*:

- **[VERIFIED]** — stated by the vendor / an authoritative engineering source, with a cited URL.
- **[INFERRED]** — reasoned from public behaviour or general practice; **not** asserted as fact.

Internal claims cite `file:line` (code/schema) or ADR/doc section.

**The four constraints every candidate must survive** (carried from the brief + [RESEARCH_01 §C.3](./RESEARCH_01_entity_modeling.md)):
(1) **billions of golden entities × ~15–20 fields** — any "one row per (entity, field, source)" structure is its
own multi-hundred-billion-row table; (2) **Layer 0 is system-owned, not RLS-scoped** ([ADR-0021:33-35](../decisions/ADR-0021-global-master-graph-and-overlay.md))
— provenance on the master carries **no `tenant_id`/`workspace_id`**; (3) **the golden row is the hot OLTP +
search-projection surface** — provenance must not bloat it or force a join on the read path; (4) **MATCH-AGAINST ≠
CONTRIBUTE-TO** ([ADR-0021:53-65](../decisions/ADR-0021-global-master-graph-and-overlay.md)) — a workspace's
hand-edit is workspace-private and must not leak into the golden record or name a contributing workspace.

---

## Part A — How the leading MDM & data platforms merge + store provenance

### A.1 Informatica MDM — trust-scored, validated, **cell-level** survivorship

- **[VERIFIED]** Informatica resolves conflicts **per cell** (per attribute of a pair), not per record: "the MDM
  Hub determines which cell data survives… the winning cell representing the better version of the truth between
  the two cells," decided **in order of precedence** — first by **trust score** (only for trust-enabled columns),
  then by **validation rules**, then fallbacks. Each source carries a configurable trust that **decays with age**
  and can be down-weighted by validation. Sources:
  [docs.informatica.com — cell data survivorship & order of precedence](https://docs.informatica.com/master-data-management/multidomain-mdm/10-4/configuration-guide/part-4--configuring-the-data-flow/mdm-hub-processes/about-informatica-mdm-hub-processes/cell-data-survivorship-and-order-of-precedence.html),
  [profisee.com — MDM survivorship](https://profisee.com/blog/mdm-survivorship/).
- **Lesson:** trust-score × recency × validation, applied **per attribute**, is exactly TruePoint's golden formula
  "most-recent × most-corroborated × highest-trust source" ([06 §9:315-316](../06-enrichment-engine.md)). The
  novel point for us is that trust is **per-(source, column)**, not a single global source rank — a provider may be
  authoritative for `job_title` but weak for `mobile_phone`.

### A.2 Reltio — **crosswalks** retain every value; the golden value is computed **at read** (OV)

This is the most directly transferable model and worth detailing.

- **[VERIFIED]** A **crosswalk** links each attribute value to its originating source and stores per-value
  metadata: **source-system id, creation date, and update timestamps** (`singleAttributeUpdateDate`, `updateDate`,
  `sourcePublishDate`). When entities merge, **all contributing values persist** — a person's `first_name` may hold
  "Mike", "Mikey", "Michael" from three sources — nothing is discarded. Source:
  [docs.reltio.com — survivorship rules](https://docs.reltio.com/en/model/consolidate-data/design-survivorship-rules/survivorship-rules).
- **[VERIFIED]** The **Operational Value (OV)** — the "best value" returned to callers — is **computed at query
  time** from the configured rule, marking winners with an OV flag. Rule types: **LUD** (last-update-date, the
  default), **Source-System Priority**, **Max/Min**, **Frequency** (most crosswalks agree), **Aggregation** (all
  survive). Sources:
  [docs.reltio.com — survivorship rules](https://docs.reltio.com/en/model/consolidate-data/design-survivorship-rules/survivorship-rules),
  [support.reltio.com — survivorship](https://support.reltio.com/hc/en-us/articles/360026781592-Survivorship-description-of-rules-and-additional-information).
- **[VERIFIED]** **Pinned values bypass survivorship entirely** — "Survivorship rules are not applied… if one of
  those values is pinned. All pinned values become OV's." This is **human-judgment supremacy** over the algorithm.
  Each source keeps a **unique URI** so a merge is **reversible (unmerge)**, and Reltio can **auto-unmerge** when a
  source value changes such that the match criteria no longer hold. Source:
  [docs.reltio.com — survivorship rules](https://docs.reltio.com/en/model/consolidate-data/design-survivorship-rules/survivorship-rules),
  [docs.reltio.com — match and merge](https://docs.reltio.com/en/reltio/what-does-reltio-do/what-reltio-does-at-a-glance/data-unification-and-mdm-at-a-glance/data-unification-and-mdm-in-detail/reltio-match-and-merge).
- **Lesson for TruePoint:** the **crosswalk is exactly `source_records`** — TruePoint *already has* the
  "retain every contributing value + its source + timestamps" store (`source_records.raw_data` + `match_keys` +
  `ingested_at`, `resolved_person_id` [03:461-471](../03-database-design.md)). The open design choices are (a)
  whether to compute the golden value **at read** (Reltio) or **materialize** it on write, and (b) where the
  **pin** lives. At our scale and read pattern (§C) the answer diverges from Reltio on (a).

### A.3 Profisee / Smile CDR / Data Ladder — the survivorship rule taxonomy

- **[VERIFIED]** The mature MDM rule set is a **cascade of per-attribute rules**: **source-system precedence**
  (e.g. "SAP wins for financials"), **most-recent-wins**, **most-complete-wins** (fewest nulls), **trust-score
  based** (per-source-per-attribute reliability), **frequency / most-corroborated**, and **conditional** (if-then
  domain logic). Automated merge handles high-confidence matches; **lower-confidence routes to a human steward**,
  whose edits are **recorded as data, not side effects**. Sources:
  [profisee.com — MDM survivorship](https://profisee.com/blog/mdm-survivorship/),
  [smilecdr.com — MDM survivorship](https://smilecdr.com/docs/mdm/mdm_survivorship.html),
  [dataladder.com — data survivorship guide](https://dataladder.com/guide-to-data-survivorship-how-to-build-the-golden-record/),
  [dev3lop.com — survivorship rules](https://dev3lop.com/blog/master-data-survivorship-rules-implementation/).
- **Lesson:** TruePoint's cascade is already named — source-trust → recency → corroboration (`source_count`) →
  completeness, with the conditional **human-entered > verified-provider > inferred** ([ADR-0015:70-75](../decisions/ADR-0015-entity-resolution-dedup-engine.md)).
  The research confirms this is the industry-standard ordering; the gap is purely **where the per-field decision and
  its evidence are stored** so it is recomputable, reversible, and explainable.

### A.4 The B2B-data vendors — what they expose as "confidence" / source

- **[VERIFIED]** ZoomInfo attaches a **confidence/accuracy signal per record** built from automated collection +
  ML + human review + a contributor community; merge is a **field-level multi-source waterfall** ("evaluates 25+
  providers for every field, returns the highest-confidence result"). Sources:
  [pipeline.zoominfo.com — algorithms](https://pipeline.zoominfo.com/sales/data-demystified-algorithms),
  [pipeline.zoominfo.com — apollo vs zoominfo](https://pipeline.zoominfo.com/sales/apollo-vs-zoominfo).
- **[VERIFIED]** Clay makes **per-field survivorship a first-class, user-tunable decision** ("decide which field
  wins when sources conflict") and treats provenance as a **chain** (a value derived *from* a prior column's
  value). Source: [clay.com — data waterfalls](https://www.clay.com/blog/data-waterfalls).
- **[INFERRED]** Whether ZoomInfo/Apollo surface a *per-field* source/confidence to the end user (vs a single
  record-level confidence + freshness badge) is **not clearly documented**; public behaviour suggests record- or
  channel-level surfacing, not per-attribute lineage UI. Treated as inference, not fact.
- **Lesson:** the market consensus is **per-field highest-confidence survivorship**; what is *exposed* is usually a
  coarse per-record (or per-channel) confidence + freshness. TruePoint's `email_status` + `last_verified_at` +
  `data_quality_score` ([03:444-447,544-546](../03-database-design.md)) already match the **exposed** granularity;
  the **internal** decision needs finer (per-field) provenance to be honest and recomputable.

### A.5 Splink — calibrated thresholds + clerical review (the merge *gate*)

- **[VERIFIED]** Splink trains a **Fellegi-Sunter** model unsupervised (Expectation-Maximisation), emitting a
  **match weight** per pair. **Two thresholds** route: above an upper cutoff → auto-link, below a lower → non-match,
  **between → clerical review**. Thresholds are **calibrated against a clerically-labelled sample**: pairs are
  sampled across the weight range, human-reviewed, and the labels estimate **precision/recall** for the whole set;
  **precision rises as the threshold rises** (fewer false merges), **recall rises as it falls**. Sources:
  [moj-analytical-services.github.io/splink — accuracy from labels](https://moj-analytical-services.github.io/splink/charts/accuracy_analysis_from_labels_table.html),
  [gov.uk — MoJ Splink master record](https://www.gov.uk/algorithmic-transparency-records/moj-splink-master-record),
  [horkan.com — Fellegi-Sunter practical guide](https://horkan.com/2026/01/05/wtf-is-the-fellegi-sunter-model-a-practical-guide-to-record-matching-in-an-uncertain-world).
- **Lesson:** this is **already TruePoint's design** — `match_links.match_probability` + `review_status
  ('auto','pending','confirmed','rejected')` ([03:478-482](../03-database-design.md)), two calibrated cutoffs, the
  **precision ≥ 0.95 / false-merge ≤ 0.5%** targets ([22:152-153](../22-data-quality-freshness-lifecycle.md)), and
  a **customer-facing duplicate-review queue** ([ADR-0015:84-90](../decisions/ADR-0015-entity-resolution-dedup-engine.md)).
  Phase 3 *consumes* this gate; it does not redesign it. The relevance to provenance: the **review band is where a
  human's field-level pick must be captured** as provenance, not just a yes/no merge.

### A.6 Cross-platform synthesis

| Dimension | Informatica | Reltio | Profisee/Smile | ZoomInfo/Clay | TruePoint target |
|---|---|---|---|---|---|
| Merge granularity | **cell-level** | **attribute-level** | attribute-level | **per-field** | per-field ([06 §9:315](../06-enrichment-engine.md)) |
| Conflict rule | trust→validation→precedence | LUD / src-priority / freq / max-min | trust / recency / complete / freq | highest-confidence waterfall | trust × recency × corroboration ([ADR-0015:70-75](../decisions/ADR-0015-entity-resolution-dedup-engine.md)) |
| All-values retained | xref base objects | **crosswalk (all values + source + ts)** | match group | provider responses | **`source_records`** ([03:461-471](../03-database-design.md)) |
| Golden value | materialized (BVT) | **computed at read (OV)** | materialized | materialized | **materialize on write** (§C) |
| Human override | steward edit (tracked) | **pin bypasses survivorship** | steward "winner" pick | per-field user rule (Clay) | **pin / user-entered outranks** ([ADR-0015:72](../decisions/ADR-0015-entity-resolution-dedup-engine.md)) |
| Reversible merge | unmerge ±lineage, audited | **unique URIs → unmerge / auto-unmerge** | exception workflow | — | **`match_links.is_duplicate_of` + replay** ([06 §9:319](../06-enrichment-engine.md)) |
| Merge gate | match rules | match rules | confidence + steward | ML + human | **Splink 2-threshold + review queue** ([22:161-171](../22-data-quality-freshness-lifecycle.md)) |

**The consensus:** retain every contributing value with its source + timestamp (a crosswalk); decide the winner
**per field** by a trust × recency × corroboration cascade; let a **human pin** override the algorithm; keep the
merge **reversible**; gate auto-merge with **calibrated thresholds + a review queue**. TruePoint already owns
**five of seven** rows of this table in its *designed* schema. The **two genuinely open** questions Phase 3 must
answer are: **(1) the storage shape of the per-field winning-value provenance** (the U1 gap), and **(2) where the
human pin lives given the system-owned-master / RLS-overlay split** (the U3 gap).

---

## Part B — The pattern toolkit

### B.1 Survivorship algorithm: LWW vs confidence-weighted vs source-priority vs cascade

| Algorithm | Picks… | Pro | Con for TruePoint |
|---|---|---|---|
| **Last-writer-wins (LWW)** | newest timestamp | trivial, commutative | **silently destroys verified + human values** (the CRDT "lost update", §B.4); the current overlay `overwrite` path is exactly this ([06 §4:141-143](../06-enrichment-engine.md), RESEARCH_00 §5) |
| **Source-priority** | highest-ranked source with a value | predictable, auditable | a single global rank is wrong — a source good for titles is bad for phones (§A.1); needs **per-(source,field)** trust |
| **Confidence-weighted** | highest model/verification confidence | aligns with verification | needs a calibrated confidence per value; risky alone (a confident-but-stale value beats a fresh one) |
| **Corroboration / frequency** | the value the most sources agree on | robust to one bad source | a popular *stale* value can win; needs a recency guard |
| **Cascade (recommended)** | **trust → recency → corroboration → completeness, with conditional human/verified override** | combines all signals in a defined order; explainable per field | more rules to store + recompute — needs field-level provenance to be recomputable |

**[VERIFIED]** Mature MDM uses the **cascade**, not any single rule, and applies it **per attribute** (§A.1, §A.3).
TruePoint's cascade is already specified ([ADR-0015:70-75](../decisions/ADR-0015-entity-resolution-dedup-engine.md),
[06 §9:315-316](../06-enrichment-engine.md)); the existing soft-dedup `pickCanonical` already encodes a mini-cascade
(revealed → most-complete → earliest → lowest-id, `dedup.ts:60-69`) and the waterfall already orders providers by
**trust ÷ cost** (`waterfall.ts:50-60`) — both reusable signal sources. **The cascade is the right algorithm;
the question is its storage substrate.**

### B.2 Human-correction precedence — the **pin**

**[VERIFIED]** Every mature platform places **human judgment above the algorithm**: Reltio *pins* (survivorship
skipped for pinned values), Informatica/Profisee record a steward "winner" pick **as data** that later loads must
respect. TruePoint mandates the same: **user-entered > verified-provider > inferred**
([ADR-0015:70-75](../decisions/ADR-0015-entity-resolution-dedup-engine.md)), and "user-entered values are not
silently overwritten by enrichment" (brief; provenance constraint). **This is impossible to honor without a
per-field flag** recording that a field is human-pinned — a bare column cannot say "don't overwrite me." This is
the load-bearing reason field-level provenance is **mandatory, not nice-to-have**.

**The TruePoint twist (the U3 gap).** Classic MDM has *one* pin scope (the steward). TruePoint has **two**, because
of the two-layer split:

- **Overlay pin (common):** a workspace hand-edits `contacts.job_title`. It is **workspace-private**, lives on the
  RLS-scoped overlay, and must **block a later re-reveal/enrichment from overwriting that workspace's value** — but
  must **not** mutate the system-owned golden record (that would be CONTRIBUTE-TO, opt-in only,
  [ADR-0021:60-62](../decisions/ADR-0021-global-master-graph-and-overlay.md)).
- **Master pin (rare, privileged):** a platform data-steward pins a golden value during clerical review
  ([22 §6](../22-data-quality-freshness-lifecycle.md)); system-owned, audited via `withPlatformTx`
  (`client.ts:95-111`), affects every workspace's future reveals.

Provenance therefore must exist **on both layers**, with different scoping rules (§C.2).

### B.3 Per-field provenance **storage options** (the core decision)

Four candidate substrates for "per-field source + confidence + observed_at":

```
(a) PHYSICAL COLUMNS          (b) NORMALIZED ROW TABLE         (c) JSONB MAP ON ROW         (d) DERIVE-AT-READ
 master_persons                field_provenance                master_persons               (compute from
  job_title                     (entity_id, field,              ...                            source_records
  job_title_source              source_record_id,               provenance jsonb {            at query time,
  job_title_confidence          confidence, observed_at,         job_title:{src,conf,obs},     Reltio-OV-style;
  job_title_observed_at         ingested_at, src_count,          email:{...}, ... }            no stored winner)
  email ... (×N fields)         is_pinned)  ← N rows/entity
```

| Option | Read cost | Write cost | Storage at billions | Schema agility | Verdict |
|---|---|---|---|---|---|
| **(a) Physical `_source/_confidence/_observed_at` columns** | cheapest (same row) | cheap | wide, **sparse**, 3×N columns | **rigid** — every new field = migration; can't hold a structured tuple cleanly | **Reject** |
| **(b) Normalized `(entity, field)` row table** | **+1 join per read**, or a fan-out | row per field per change | **billions × ~15 = 10s–100s B rows** — bigger than the golden table; its own shard + GIN | flexible | **Reject as the blanket master store** (the explosion) |
| **(c) JSONB provenance map (one column)** | same row, no join; GIN-able | one column rewrite | **one column/entity**; ~15 small descriptors; history stays in `source_records` so the map holds only the *winning* descriptor | **flexible** — new field = new key, no migration | **RECOMMEND** for the materialized winner |
| **(d) Derive-at-read (Reltio OV)** | **recompute per attribute per read** | zero stored winner | zero (uses `source_records`) | flexible | **Reject for the hot/search path** (billions QPS over a flattened OpenSearch projection can't recompute OV per attribute); **keep as the recompute path on new evidence** |

**[VERIFIED]** Column-level lineage "sharpens benefits over table-level by an order of magnitude" but is the
fine-grained, higher-cost end of the spectrum — appropriate to **materialize selectively**, not blanket. Source:
[datahub.com — data lineage benefits](https://datahub.com/blog/data-lineage-benefits/). The decisive insight:
**TruePoint already stores every candidate value in `source_records` (the crosswalk)** — so the per-field
provenance *materialization* only needs the **winning** descriptor per field, not the full candidate set. That
collapses option (c) from "N sources × N fields" to "N fields, one small JSONB", and makes the explosion of (b)
unnecessary: the *history* is the immutable log; the *map* is a thin pointer-and-decision cache.

### B.4 CRDT-ish reconciliation — applicable lens, wrong default

- **[VERIFIED]** A **LWW-Register** merges by keeping the value with the latest timestamp; merge must be
  commutative, associative, idempotent. Its known failure is the **lost-update problem**: a concurrent value is
  **silently overwritten** with no record it existed. Sources:
  [lars.hupel.info — CRDT registers & deletion](https://lars.hupel.info/topics/crdt/07-deletion/),
  [distributedsystemauthority.com — CRDTs](https://distributedsystemauthority.com/crdts),
  [electric-sql.com — rich-CRDTs](https://electric-sql.com/blog/2022/05/03/introducing-rich-crdts).
- **[VERIFIED]** A **Multi-Value Register (MV-Register)** instead **retains all concurrent values** and surfaces the
  conflict for resolution — the CRDT analog of Reltio's "retain all crosswalk values." Source:
  [lars.hupel.info — CRDT registers & deletion](https://lars.hupel.info/topics/crdt/07-deletion/).
- **Lesson:** the CRDT framing **validates the design, by negation**. A bare LWW golden field is the lost-update
  anti-pattern — exactly the "irreversible auto-merge destroys good values" failure
  ([ADR-0015:73-74](../decisions/ADR-0015-entity-resolution-dedup-engine.md)) and the current overlay `overwrite`
  behaviour (RESEARCH_00 §5). The correct posture is **MV-Register-like retention** (`source_records` keeps all
  values) **+ a deterministic survivorship function** to pick the OV — *not* timestamp-only LWW. Full CRDT
  machinery (vector clocks, op-based replication) is **overkill**: TruePoint ER is a **batch/incremental projection
  on Postgres**, not a multi-master replicated store; we get conflict-freedom from a single deterministic
  survivorship function over an append-only log, not from a replicated convergent type. **Borrow the MV-Register
  *idea*; reject the CRDT *implementation*.**

### B.5 Reversible / audited merge + **unmerge**

- **[VERIFIED]** Informatica unmerges a cross-reference **with or without lineage** (child records follow or stay),
  **audited** via the Hub audit log; Reltio mints a **unique URI per source** pre-merge so any merge is reversible,
  and **auto-unmerges** when an updated source value breaks the match. Sources:
  [docs.informatica.com — unmerging records overview](https://docs.informatica.com/master-data-management/multidomain-mdm/10-4/data-director-user-guide/part-2--data-director-with-subject-areas/unmerging-records-in-the-xref-view/unmerging-records-overview.html),
  [docs.reltio.com — match and merge](https://docs.reltio.com/en/reltio/what-does-reltio-do/what-reltio-does-at-a-glance/data-unification-and-mdm-at-a-glance/data-unification-and-mdm-in-detail/reltio-match-and-merge).
- **Lesson:** TruePoint already has the substrate — `match_links` records cluster membership +
  `is_duplicate_of` (the survivor link) + `review_status`, and `source_records` is immutable
  ([03:461-485](../03-database-design.md)); "`source_records` keeps every merge **reversible** (un-merge)"
  ([06 §9:319](../06-enrichment-engine.md)). **Because survivorship is a pure function over `source_records`, an
  unmerge does not need a separate per-field version table**: split the cluster in `match_links`, then **re-run
  survivorship over each resulting cluster's evidence** and re-materialize the JSONB map. This is strictly cheaper
  than SCD2/bitemporal field versioning ([RESEARCH_01 §B.2-B.3](./RESEARCH_01_entity_modeling.md), already rejected).

### B.6 The merge gate — thresholds + clerical-review queue (reused, not redesigned)

Covered in §A.5: two calibrated Splink cutoffs → `match_links.review_status`; the **review band** routes to the
customer overlay queue + the staff console ([ADR-0015:77-90](../decisions/ADR-0015-entity-resolution-dedup-engine.md),
[22:161-171](../22-data-quality-freshness-lifecycle.md)). Phase 3's only addition: **a clerical/customer field-pick
in the review band must be recorded as provenance** (an `is_pinned` descriptor with the actor), so a confirmed
human decision is durable and is not re-litigated by the next ER pass — the "manual actions are data, not side
effects" principle ([profisee.com](https://profisee.com/blog/mdm-survivorship/)).

---

## Part C — Mapping onto TruePoint: the constraints filter

### C.1 The scale math (why the substrate choice is forced)

```
  golden persons ≈ 1–3 B  ×  provenance-worthy fields ≈ 12–18
   ── option (b) normalized table  →  ~15–50 B rows  (+ index ≈ same again)  →  a shard cluster LARGER than master_persons
   ── option (c) JSONB map         →  +1 column on master_persons (≈ 200–600 B/row)  →  ~0.2–1.8 TB added, no new table, no join
```

A normalized `(entity, field, source)` table at the master is a **multi-tens-of-billions-row** object that must be
**re-written on every re-resolution** ([ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md)
re-verify cadences: email 90d, phone 180d, employment 60d → continuous churn). Treating N+1 and unbounded fan-out
as failures (brief scale gate), this is rejected as the **blanket** store. The JSONB map keeps provenance on the
hot row, GIN-indexable for "show me where this came from", and **defers full history to the log we already keep**.

### C.2 Where provenance lives — the two-layer placement

```
  LAYER 0 (system-owned, NO RLS)                         LAYER 1 (per-workspace overlay, RLS-scoped)
  ┌───────────────────────────────────┐                 ┌──────────────────────────────────────────┐
  │ source_records  (the crosswalk:    │   reveal copies │ contacts / accounts  (master_person_id)    │
  │   every value + source + ingested) │  golden value + │  + field_provenance jsonb {                │
  │ master_persons.field_provenance ───┼────────────────►│   job_title:{src:'master:verified',        │
  │   {field:{winning_source_record_id,│   its descriptor │     conf, observed_at, pinned:false},      │
  │    source_name, confidence,        │                  │   email:{src:'user_edit', pinned:true,     │
  │    observed_at, ingested_at,       │                  │     pinned_by:U, pinned_at:T}}             │
  │    source_count, is_steward_pinned}│                  │  ▲ workspace-private; pin blocks overwrite │
  └───────────────────────────────────┘                  └──────────────────────────────────────────┘
       isolation = ACCESS PATH (search+reveal)                 isolation = RLS (workspace_id) + owner-scope
```

- **Master provenance** is **system-owned** (no `tenant_id`/`workspace_id`), isolated by access path; it never
  names a workspace. **Co-op privacy:** the overlay descriptor for a revealed value records a **platform-level
  source label** (`master:verified`, `provider:apollo`) — **never** "workspace X contributed this"
  ([ADR-0021:53-65](../decisions/ADR-0021-global-master-graph-and-overlay.md); MATCH-AGAINST ≠ CONTRIBUTE-TO).
- **Overlay provenance** is **RLS-scoped** (on the `contacts`/`accounts` row, or a workspace-scoped child) and is
  where the **overlay pin** lives — resolving the U3 reconciliation gap (RESEARCH_00 §7.2): on reveal/enrichment,
  the overlay merge respects an overlay pin (user-entered) and otherwise takes the master OV; the master is
  untouched unless co-op opt-in.
- **The two channels that matter most already have per-field provenance** — `master_emails`/`master_phones` carry
  `source_count`, `last_verified_at`, `verification_source`, `email_status` per channel
  ([03:444-447,456-457](../03-database-design.md)). The recommendation **generalizes that existing pattern** to the
  remaining golden fields via the map, rather than inventing a parallel mechanism.

### C.3 Query cost, search, and DSAR

- **Search/read:** the OpenSearch global index ([ADR-0021:72-77](../decisions/ADR-0021-global-master-graph-and-overlay.md))
  indexes the **materialized OV**, not the provenance map; the map is fetched only on a **detail read** ("where did
  this come from?"), so provenance adds **zero cost to the billions-scale search path**. This is why we
  **materialize on write** rather than derive-at-read (rejecting Reltio's OV-at-read for our read pattern, §B.3).
- **DSAR / deletion** ([08](../08-compliance.md); brief deletion cascade): the descriptor stores a
  **`source_record_id` pointer + non-PII metadata**, never the PII value in clear, so erasure = tombstone the
  golden value + null its map entry + tombstone the referenced `source_records` row, with the existing
  golden→source→overlay cascade ([ADR-0021:129-130](../decisions/ADR-0021-global-master-graph-and-overlay.md)). The
  map makes "where did this email come from" answerable **per field**, upgrading DSAR provability from today's
  batch granularity (RESEARCH_00 §5).
- **Audit & change history** (pre-build pass item 4): a field's value change is captured by a **new `source_records`
  row + a survivorship recompute**; the *winning-descriptor delta* is what the audit/`audit_log`
  ([03:682](../03-database-design.md)) records (actor/system, field, old→new winning source) — not a full per-field
  version chain (that lives implicitly in the immutable log).

### C.4 Pre-build thinking pass — load-bearing answers

1. **Source of truth.** `source_records` (immutable log/crosswalk) is truth; the golden value + `field_provenance`
   map is a **materialized survivorship projection**; the OpenSearch doc is a derived query surface
   ([RESEARCH_01 §C.2](./RESEARCH_01_entity_modeling.md)).
2. **Failure modes / idempotency.** Survivorship is a **pure deterministic function** over a content-hash-idempotent
   log (`source_records.content_hash` UNIQUE, [03:464](../03-database-design.md)) → re-runs converge (the
   MV-Register + deterministic-resolve posture, §B.4); a re-resolution **rebuilds** the map, never appends garbage.
3. **Duplicate prevention.** `match_links` clusters + `is_duplicate_of`; deterministic keys backed by DB uniques
   (`master_emails.email_blind_index UNIQUE`, [03:442](../03-database-design.md)) so concurrent ingests can't mint
   a duplicate channel.
4. **Security (IDOR/exposure).** Master provenance carries no workspace id and no foreign workspace's source label
   (co-op privacy); overlay provenance is RLS-scoped + owner-scoped on read. Security has final say here
   (CLAUDE.md precedence) — the descriptor must be scrubbed of any cross-workspace attribution.
5. **Scalability / 10x.** JSONB map = +1 column, no join, no new billions-row table; search indexes only the OV.
6. **Rollback.** Map is **derived** → rebuildable from `source_records` by replay; an unmerge re-runs survivorship
   (§B.5). The feature ships behind a flag; the migration is additive (a nullable JSONB column), reversible.
7. **Edge cases.** No evidence → empty map (field null, descriptor absent); single source → `source_count=1`;
   pinned-then-source-changes → pin wins until un-pinned (the lost-update we *want*); concurrent reveal of the same
   contact → idempotent on `(workspace_id, contact_id, reveal_type)` ([03:560](../03-database-design.md)).

---

## Part D — Tradeoff summary

| Approach | Honors human edits | Recompute on new source | Reversible (field) | Scale at billions×N | Read cost | Verdict |
|---|---|---|---|---|---|---|
| Bare golden field, **blind LWW** | **no** (lost update) | no | no | lowest | lowest | **Reject** (= current `overwrite`, RESEARCH_00 §5) |
| Physical `_source/_conf/_obs` columns (a) | yes (per col) | yes | partial | sparse/rigid | low | **Reject** (rigidity) |
| Normalized `(entity,field,source)` table (b) | yes | yes | yes | **10s–100s B rows** | +join | **Reject as blanket master store** |
| Derive-at-read OV, no stored winner (d) | yes | implicit | yes | zero store | **recompute/read** | **Reject for hot/search path** |
| Full SCD2 / bitemporal per attribute | yes | yes | yes | **highest write-amp** | high | **Reject** (RESEARCH_01 §B.2-B.3) |
| **`source_records` crosswalk + cascade survivorship + JSONB winning-descriptor map (master & overlay) + pin + Splink-gated reversible merge** | **yes** | **yes (pure fn)** | **yes (replay)** | **+1 col, lean log cold** | **lowest (OV materialized)** | **RECOMMEND** |

---

## Recommendation

**Adopt a crosswalk-plus-materialized-map provenance model — explicitly *not* a per-field row table and *not*
derive-at-read — composed of five parts, every one of which extends a structure TruePoint already has rather than
inventing a parallel mechanism:**

1. **`source_records` is the crosswalk (retain everything).** Treat the existing immutable, content-hash-idempotent
   `source_records` log ([03:461-471](../03-database-design.md)) as the Reltio-style crosswalk: every contributing
   value, its `source_name`, `match_keys`, and `ingested_at` are retained forever. This is the MV-Register
   "retain all concurrent values" posture (§B.4) and the full lineage — no value is ever silently lost. Nothing new
   is needed here except that the ER pipeline must write a `source_records` row **per field-contributing source**
   (already the intent at [06 §4:135-143](../06-enrichment-engine.md)).

2. **Survivorship is a pure per-field cascade, not LWW.** Compute each golden value by the named cascade —
   **(human-pinned) → highest-(source,field)-trust → most-recent-verified → most-corroborated (`source_count`) →
   most-complete** ([ADR-0015:70-75](../decisions/ADR-0015-entity-resolution-dedup-engine.md),
   [06 §9:315-316](../06-enrichment-engine.md)) — reusing the waterfall trust order (`waterfall.ts:50-60`) and the
   `pickCanonical` tiebreaks (`dedup.ts:60-69`) as signal sources. Reject blind LWW and whole-record overwrite
   (the CRDT lost-update anti-pattern, §B.4).

3. **Materialize the *winning* descriptor per field as a JSONB map on the row** — `field_provenance jsonb` on
   `master_persons`/`master_companies` (system-owned) **and** on the `contacts`/`accounts` overlay (RLS-scoped),
   each key holding only the small winning tuple `{winning_source_record_id, source_name, confidence, observed_at
   (valid-time), ingested_at (transaction-time), source_count, is_pinned}`. One column, no join, GIN-indexable,
   new fields need no migration; the *history* stays in `source_records`, so the map stays tiny (§B.3, §C.1).
   Generalize the **already-shipped** per-channel provenance on `master_emails`/`master_phones`
   ([03:446-447](../03-database-design.md)) to the remaining fields via this map.

4. **The human pin lives on both layers, scoped correctly.** An **overlay pin** (user hand-edit) is
   workspace-private, blocks a later reveal/enrichment from overwriting *that workspace's* value, and **never**
   mutates the golden record (CONTRIBUTE-TO is opt-in, [ADR-0021:60-62](../decisions/ADR-0021-global-master-graph-and-overlay.md));
   a **master/steward pin** is system-owned, audited (`withPlatformTx`), and set in clerical review. Overlay
   descriptors record a **platform-level source label only** (`master:verified`, `provider:apollo`), never a
   contributing workspace — the co-op privacy + system-owned boundary (§C.2). This resolves the U3
   overlay↔master reconciliation gap (RESEARCH_00 §7.2).

5. **Reversible merge is replay, not versioning.** Reuse `match_links.is_duplicate_of` + `review_status` and the
   Splink two-threshold gate ([22:161-171](../22-data-quality-freshness-lifecycle.md)); an unmerge splits the
   cluster and **re-runs survivorship over each side's `source_records`**, rebuilding the JSONB map — no per-field
   version table. Record clerical/customer field-picks in the review band as `is_pinned` provenance ("manual actions
   are data", §B.6).

This keeps provenance **Layer-aware** (system-owned master map carries no RLS column; overlay map is workspace- and
owner-scoped), **scale-safe** (one column, the heavy log cold in S3/Iceberg, search indexes only the OV), and
**honest** (human edits and verified values survive; "where did this field come from" is answerable per field for
product UX *and* DSAR).

### What this rejects, and why

- **Blind last-writer-wins / whole-record overwrite — rejected.** The CRDT lost-update anti-pattern
  ([lars.hupel.info](https://lars.hupel.info/topics/crdt/07-deletion/)); it destroys verified data and human
  corrections — the exact failure [ADR-0015:73-74](../decisions/ADR-0015-entity-resolution-dedup-engine.md) forbids
  and the current overlay `overwrite` exhibits (RESEARCH_00 §5).
- **A normalized `(entity, field, source)` provenance table as the *blanket* master store — rejected.** At
  billions × ~15 fields it is a multi-tens-of-billions-row object, re-written on every re-verification cadence
  ([ADR-0025](../decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md)) — its own shard cluster,
  and an N+1/fan-out failure against the scale gate (§C.1). (A narrow normalized table is acceptable *only* for the
  few genuinely multi-valued channels — and we already have it: `master_emails`/`master_phones`.)
- **Per-field physical `_source/_confidence/_observed_at` columns — rejected.** Rigid (every new field is a
  migration), sparse, and they cannot carry the structured descriptor cleanly (§B.3 option a).
- **Reltio-style derive-the-OV-purely-at-read — rejected for the hot/search path.** Recomputing survivorship per
  attribute per read does not survive billions-QPS search over a flattened OpenSearch projection
  ([ADR-0021:72-77](../decisions/ADR-0021-global-master-graph-and-overlay.md)); materialize on write, recompute only
  on new evidence/unmerge. (We **keep** Reltio's *retain-all-values* and *pin-bypasses-survivorship* ideas — just
  not its read-time computation model.)
- **Full SCD2 / bitemporal versioning per attribute — rejected** (restating [RESEARCH_01 §B.2-B.3](./RESEARCH_01_entity_modeling.md)):
  the immutable `source_records` log already gives both time axes more cheaply; valid-time stays *selective* (the
  employment edge + channel status), not blanket.
- **Any provenance structure carrying `tenant_id`/`workspace_id` on the master, or naming a contributing workspace
  in an overlay descriptor — rejected.** It breaks the system-owned boundary
  ([ADR-0021:33-35](../decisions/ADR-0021-global-master-graph-and-overlay.md)) and the MATCH-AGAINST ≠ CONTRIBUTE-TO
  / co-op privacy rule; security has final say (CLAUDE.md precedence).
- **Full CRDT machinery (vector clocks, op-based replication) — rejected as over-engineering.** TruePoint ER is a
  batch/incremental Postgres projection, not a multi-master replicated store; a single deterministic survivorship
  function over an append-only log delivers convergence without the CRDT runtime (§B.4).

**Implementation status (gap → work-to-do, not license to skip a rule).** Field-level provenance is **undesigned
anywhere today** — provenance is batch/job-level only (`source_imports` `contacts.ts:212-245`; `provider_calls`
`intel.ts:88-114`; `enrichment_job_rows.enriched_fields` `enrichmentJobs.ts:131`), and [ADR-0006:51](../decisions/ADR-0006-per-workspace-multitenant-model.md)
consciously accepted its absence (RESEARCH_00 §5). The master tables this recommendation extends (`source_records`,
`match_links`, `master_emails.source_count`/`last_verified_at`) are **designed in [03 §5.1](../03-database-design.md)
but not built**, and the JSONB `field_provenance` map + the overlay pin are the **net-new Phase-3 invention**. None
of these gaps relaxes a constraint: when built, master provenance stays system-owned (no RLS column, no foreign
workspace attribution), survivorship stays a deterministic per-field cascade, human pins outrank provider guesses,
and the deterministic resolution keys stay backed by DB uniques ([03:442,464](../03-database-design.md)) so
concurrent ingests cannot mint duplicates. The BRAINSTORM gate should turn this into concrete DDL options
(map shape, descriptor keys, the overlay-pin merge algorithm) and the PLAN gate into a migration + survivorship-fn
spec.
