# RESEARCH 01 — Canonical Entity Modeling for Golden Person + Company Records

> **Gate:** RESEARCH · **Phase:** 1 — Canonical Entity Model · **Depends on:** the shared ground-truth brief
> for this initiative, [ADR-0021](../decisions/ADR-0021-global-master-graph-and-overlay.md) (the two-layer
> model), [03 §5.1](../03-database-design.md) (the Layer-0 DDL), [06 §9](../06-enrichment-engine.md) (the ER
> pipeline), and [ADR-0015](../decisions/ADR-0015-entity-resolution-dedup-engine.md). **Feeds:** the Phase-1
> BRAINSTORM and PLAN gates, and Phase-3 (field-level provenance). This doc **researches and documents only** —
> it proposes no schema and writes no code.

---

## 0. Scope, method, and epistemics

This document answers one question: **what is the right canonical-entity shape for TruePoint's Layer-0 golden
person + company records**, given (a) how the leading B2B-data platforms actually model the same problem and
(b) the established data-engineering / MDM patterns for golden records, temporal facts, and lineage. It maps
each pattern onto the TruePoint target tables (`master_persons`, `master_companies`, `master_employment`,
`master_emails`/`master_phones`, `source_records`, `match_links` — [03 §5.1:379–486](../03-database-design.md))
and ends with a single recommended approach plus what it rejects and why.

**Epistemic legend.** External platform internals are proprietary; this doc separates what vendors *state*
from what is *reasoned* from public behaviour:

- **[VERIFIED]** — stated by the vendor or an authoritative engineering source, with a cited URL.
- **[INFERRED]** — reasoned from public product behaviour / general practice; **not** asserted as fact.

Internal claims cite `file:line` (code/schema) or ADR/doc section.

---

## Part A — How the leading platforms model person + company

The market splits into two model families: **owned-graph vendors** that operate a single canonical entity
graph (ZoomInfo, Apollo, Cognism, LinkedIn) and **orchestration vendors** that resolve/merge at query time
across many third-party sources (Clay; Clearbit/Breeze sits between). TruePoint's Layer 0 is squarely the
owned-graph family ([ADR-0021:33–45](../decisions/ADR-0021-global-master-graph-and-overlay.md)).

### A.1 ZoomInfo

- **[VERIFIED]** Every company and contact carries a **stable canonical surrogate ID** — the *ZoomInfo Company
  ID* and *ZoomInfo Contact ID* — used as the primary key "across your data layer, giving every downstream
  system a single, authoritative source of truth." Source:
  [zoominfo.com/data](https://www.zoominfo.com/data),
  [help.zoominfo.com GTM Data Model](https://help.zoominfo.com/s/article/Overview-of-the-GTM-Data-Model-Data-Sets-for-Accounts-for-GTM-Studio).
- **[VERIFIED]** Merge is a **field-level multi-source waterfall**: "evaluates 25+ data providers for every
  field and returns the highest-confidence result," firmographics validated first, then contact fields
  (phone, email, title). Source:
  [pipeline.zoominfo.com — algorithms](https://pipeline.zoominfo.com/sales/data-demystified-algorithms).
- **[VERIFIED]** The **entity-rollup model is configurable** (site-level / country-level / HQ / ultimate-parent)
  so the company hierarchy reflects how a customer organises the world. Source:
  [help.zoominfo.com](https://help.zoominfo.com/s/article/Overview-of-the-GTM-Data-Model-Data-Sets-for-Accounts-for-GTM-Studio).
- **Lesson for TruePoint:** stable surrogate PKs (we already use `uuid_generate_v7()`), **field-level**
  (not record-level) survivorship, and a **company hierarchy** (`master_companies.parent_company_id`
  [03:397](../03-database-design.md)). Their "every field, highest-confidence" is exactly our waterfall
  (`packages/core/src/enrichment/waterfall.ts`) lifted to the golden layer.

### A.2 Apollo.io

- **[VERIFIED]** A **"Living Data Network"**: data is updated "in real-time whenever it captures a data
  signal like a new job, email, or direct phone number." This is **event-driven incremental update**, not
  periodic full rebuild. Source:
  [apollo.io/product/living-data-network](https://www.apollo.io/product/living-data-network).
- **[VERIFIED]** **Corroboration-gated insert**: Apollo "only adds a piece of data to its database if
  multiple separate users and accounts have the same verified information." Source:
  [apollo.io data-freshness](https://www.apollo.io/insights/how-do-i-keep-my-b2b-contact-database-fresh-and-avoid-data-decay).
- **[INFERRED]** Job-change tracking implies a **temporal employment relationship** (an old affiliation is
  closed and a new one opened) rather than an overwrite of a single "current company" field — otherwise the
  prior role could not be retained or signalled on.
- **Lesson for TruePoint:** the **corroboration count** maps directly to `master_emails.source_count` /
  `master_phones.source_count` ([03:446,457](../03-database-design.md)) as a survivorship input; "real-time on
  a signal" maps to incremental ER ([06 §9:317](../06-enrichment-engine.md)); job-change tracking is the
  argument for **employment-as-edge with close-don't-delete** (§B.1, §B.2).

### A.3 Clay

- **[VERIFIED]** **Waterfall enrichment**: stacks 75–150+ providers in sequence; on empty/invalid, falls
  through to the next until a usable value appears. Sources:
  [clay.com/waterfall-enrichment](https://www.clay.com/waterfall-enrichment),
  [university.clay.com — waterfalls](https://university.clay.com/docs/building-a-data-waterfall).
- **[VERIFIED]** **Survivorship is a first-class, user-tunable, per-field decision**: users "decide which
  field wins when sources conflict," and an enrichment column can take its input from a prior column (chained
  provenance — Clearbit's domain feeds the email-finder, whose verified email feeds a deliverability check).
  Source: [clay.com/blog/data-waterfalls](https://www.clay.com/blog/data-waterfalls).
- **Lesson for TruePoint:** Clay externalises what TruePoint must internalise in the golden layer — **conflict
  resolution is per-field and rule-driven**, and provenance is a chain (a value is derived *from* a prior
  source, not minted from nothing). This is the strongest market argument for **field-level provenance** as a
  first-class structure, not a batch-level afterthought.

### A.4 Clearbit / HubSpot Breeze Intelligence

- **[VERIFIED]** A B2B foundation of ~200M contacts / ~20M companies with **real-time record enrichment** of
  firmographic, technographic, and contact data; **corporate hierarchies** (parent/subsidiary); **normalized
  role & seniority** to standardise titles; granular industry taxonomy (6-digit NAICS / GICS / SIC). Sources:
  [warmly.ai Breeze review](https://www.warmly.ai/p/blog/breeze-intelligence-review),
  [marketbetter.ai Clearbit 2026](https://marketbetter.ai/blog/clearbit-review-2026/).
- **[VERIFIED]** **Identity resolution from weak signals** — IP-address → company is core (anonymous visitor
  de-anonymisation). Source: [fl0.com comparison](https://fl0.com/blog/fl0-vs-clearbit-hubspot-breeze-intelligence-identity-resolution-platform-comparison-2026).
- **Lesson for TruePoint:** **standardised dimensions are entities, not free text** — normalised seniority and
  industry taxonomies. Our schema already encodes `seniority_level` as a closed enum
  ([03:415–416](../03-database-design.md)); the research point is that **title → standardised title** and
  **industry → taxonomy node** belong in the canonical layer so faceting and ER both key off the same values
  (echoed by LinkedIn, §A.6).

### A.5 Cognism

- **[VERIFIED]** A **"proprietary data-fusion engine"** that "stitches hundreds of pieces of data together per
  company" from news, press releases, earnings reports, public registries, and validated third-party vendors,
  then passes them "through a series of verification layers." Source:
  [cognism.com/diamond-data](https://www.cognism.com/diamond-data).
- **[VERIFIED]** **Verification is a distinct provenance dimension**: *Diamond Data* mobiles are **human-phone-
  verified** before entering the dataset (87% connect rate). Source:
  [info.cognism.com diamond-data](https://info.cognism.com/diamond-data-cognism).
- **[VERIFIED]** **Compliance gating at the data layer**: GDPR notification-of-inclusion within statutory
  windows and regular scrubbing against 15+ DNC/TPS lists. Source:
  [cognism.com/compliance](https://www.cognism.com/compliance).
- **Lesson for TruePoint:** verification status + source + timestamp are **per-channel** facts, exactly our
  `master_emails`/`master_phones` (`email_status`, `last_verified_at`, `verification_source`,
  [03:444–447](../03-database-design.md)); and **suppression/consent are enforced at the canonical layer**, which
  our `master_persons.is_suppressed` ([03:421](../03-database-design.md)) already anticipates.

### A.6 LinkedIn Economic Graph (the planetary reference implementation)

- **[VERIFIED]** A knowledge graph of **>1B member nodes, ~67M companies, ~250B edges**; members are connected
  by **reified, standardised entities** — `Title_9`, `Company_1337`, `Industry_6`, `Skill_198`. Sources:
  [economicgraph.linkedin.com](https://economicgraph.linkedin.com/),
  [linkedin.com/blog/engineering — economic graph infra](https://www.linkedin.com/blog/engineering/economic-graph/from-the-economic-graph-to-economic-insights-building-the-infra).
- **[VERIFIED]** Company matching = **inverted-index blocking** (name word-n-grams after stop-word removal;
  websites indexed by domain, with special handling for aggregator URLs) → **L1** string-similarity model to
  subset candidates → **L2** ranker over name similarity, domain/URL match, industry match, geographic match,
  plus page-quality signals; trained wide-n-deep / wide-only models on ~1M examples; users may **manually
  override**. Source:
  [linkedin.com/blog/engineering — matching external companies](https://www.linkedin.com/blog/engineering/economic-graph/matching-external-companies-to-linkedin-s-economic-graph-at-scal).
- **Lesson for TruePoint:** LinkedIn is **employment-as-edge at planetary scale** (member↔company↔title is an
  edge with attributes), and its matcher is **blocking → cheap subset → expensive rank → human override** —
  structurally identical to our **deterministic keys → blocking/MinHash-LSH → Splink → clerical review**
  ([06 §9:305–325](../06-enrichment-engine.md)). It validates both our edge model and our ER ladder against the
  largest existing instance of this exact problem.

### A.7 Cross-platform synthesis

| Dimension | ZoomInfo | Apollo | Clay | Clearbit/Breeze | Cognism | LinkedIn EG |
|---|---|---|---|---|---|---|
| Canonical entity | owned graph, stable IDs | owned "living" graph | query-time resolve | owned + IP-resolve | owned fusion graph | owned graph, std. IDs |
| Person↔company link | account rollup | edge (job-change) [INFERRED] | flat columns | hierarchy + role | fused record | **reified edge** [VERIFIED] |
| Merge granularity | **per-field** | per-field + corroboration | **per-field, tunable** | per-field | per-field + verify | per-edge/attribute |
| Freshness model | continuous | **event-signal real-time** | on-run | real-time | verify-layer | continuous |
| Corroboration | confidence | **multi-source gate** | provider count | confidence | source_count | edge weight |
| Std. taxonomies | industry | title/seniority | passthrough | **NAICS/role/seniority** | firmographic | **Title/Industry nodes** |

**The consensus the market has converged on:** a single owned canonical graph; stable surrogate IDs;
**field-level** survivorship driven by source trust + recency + corroboration; the person↔company link as a
**temporal edge** (so a job change is a state transition, not an overwrite); verification + suppression as
first-class per-channel facts; and standardised taxonomy entities for title/industry/seniority. TruePoint's
[03 §5.1](../03-database-design.md) schema already embodies most of this; the **named gap** the market makes
glaring is **field-level provenance** (every platform merges per-field, yet our golden tables today record no
per-field source/confidence/timestamp — see §C.4).

---

## Part B — The canonical-entity-modeling patterns (the toolkit)

### B.1 Person-as-node vs employment-as-edge

Two ways to model "Jane works at Acme as VP Sales":

- **Person-as-node, company-as-attribute** — a single `current_company` / `job_title` on the person row. Simple,
  one row per person, no join. **But** it holds exactly one affiliation, no history, no multi-affiliation
  (advisor + operator), and no per-edge provenance. This is precisely the **current overlay gap**:
  `contacts.account_id` is a single direct FK with no history (`packages/db/src/schema/contacts.ts:98`).
- **Employment-as-edge (reified relationship)** — person and company are nodes; the affiliation is its own
  entity carrying title, dates, `is_current`. Supports current + past + concurrent roles, edge-level dates and
  provenance, and makes "person at company with these company traits" a first-class queryable. Cost: an extra
  table and a join (mitigated by denormalising the current edge onto the person).

```
  PERSON-AS-NODE (rejected)            EMPLOYMENT-AS-EDGE (target)
  ┌───────────────┐                    ┌──────────────┐   ┌────────────────────┐   ┌────────────────┐
  │ person        │                    │ master_      │ 1 │ master_employment  │ * │ master_        │
  │  current_co ──┼─► (one, no hist.)  │  persons     │◄──┤ (title, dept,      ├──►│  companies     │
  │  job_title    │                    │  current_co_ │   │  seniority,        │   │ primary_domain │
  └───────────────┘                    │  id (denorm) │   │  is_current,       │   │ parent_co_id   │
                                       └──────────────┘   │  started/ended_on) │   └────────────────┘
                                                          └────────────────────┘
```

**[VERIFIED]** This is the industry-standard shape for evolving affiliations: temporal knowledge graphs model
"employed as / works at" as **edges that evolve over time**, with edges carrying timestamps + provenance +
confidence as metadata. Sources:
[MDPI — person–job temporal KG](https://www.mdpi.com/2504-2289/9/11/287),
[glean.com — enterprise knowledge graph](https://www.glean.com/blog/knowledge-graph-agentic-engine).
TruePoint **already chose this** — `master_employment` ([03:428–436](../03-database-design.md)) with the
current edge denormalised onto `master_persons.current_company_id` ([03:413](../03-database-design.md)). This
research **affirms** the choice; the open question is how the edge handles *time* (§B.2).

### B.2 Bi-temporal modeling — valid-time vs transaction-time

A bitemporal fact carries two independent axes:
**[VERIFIED]** **valid-time** (when the fact is true in the real world) and **transaction-time** (when the
system knew it). Source:
[getdozer.io — data shapes](https://getdozer.io/blog/data-shapes/),
[softwarepatternslexicon.com — bi-temporal SCD2](https://softwarepatternslexicon.com/bitemporal-modeling/bi-temporal-data-warehouses/bi-temporal-slowly-changing-dimensions-scd-type-2/).

The agent-memory KGs make the operational pattern concrete: **[VERIFIED]** Graphiti/Zep track
`valid_at` (real-world true-from), `invalid_at` (real-world true-until), `created_at`/`expired_at` (system
ingestion + logical-delete), and **when a new fact contradicts an old one they *close the old fact's validity
window rather than delete it*** — "invalidate, not discard," preserving history without recompute. Sources:
[neo4j.com — Graphiti](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/),
[arxiv.org/html/2501.13956v1 — Zep](https://arxiv.org/html/2501.13956v1).

- **Valid-time on TruePoint today:** `master_employment.started_on` / `ended_on` / `is_current`
  ([03:433](../03-database-design.md)) are exactly a valid-time interval on the employment edge.
- **Transaction-time on TruePoint today:** absent on the golden records. `source_records.ingested_at`
  ([03:470](../03-database-design.md)) is the *evidence's* transaction-time, but no golden row records "as-of
  when did we believe email = X."

**Tradeoff:** full bitemporality (both axes on every attribute of every golden row) is maximally correct and
maximally expensive — two interval columns × every attribute, and every change writes a new version. At
billions of rows this is a storage and write-amplification non-starter as a *blanket* policy; it is worth it
**only where the domain is genuinely temporal** (the employment edge; contact-channel status lifecycle).

### B.3 Slowly Changing Dimension (SCD) Type 2

**[VERIFIED]** SCD2 keeps history by **creating a new row version on every change** and marking the prior row
historical (effective-from/effective-to + is-current); it captures **one** time axis (valid-time), not
transaction-time. Sources:
[en.wikipedia.org — SCD](https://en.wikipedia.org/wiki/Slowly_changing_dimension),
[dev.to — SCD & temporal databases](https://dev.to/sirixdb/slowly-changing-dimensions-and-temporal-databases-58p2).

Applied to a golden person/company table, SCD2 means *every firmographic/title/email change spawns a new
golden row version*. Pros: simple, well-understood, queryable point-in-time. Cons at our scale: (1) the golden
table is the **hot OLTP + search-projection surface**; versioning it inline bloats it and slows the
"current-state" read that 99% of queries want; (2) it still only gives valid-time; (3) it duplicates history
that the **immutable `source_records` log already holds** — paying twice.

### B.4 Event-sourced `source_records` + survivorship

The **event-sourcing** posture: the immutable, append-only **log of source observations is the system of
record**; the golden record is a **projection** (a materialised current-state view) derived by replaying +
merging the log. **[VERIFIED]** This is precisely how the temporal-KG literature frames provenance — "every
entity and relationship traces back to the episodes (raw data) that produced it, providing full lineage from
derived fact to source," and stale facts are invalidated, not deleted. Source:
[neo4j.com — Graphiti](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/).

TruePoint already has the log: `source_records` is "immutable per-source raw evidence feeding ER (lineage),"
keyed by `content_hash` for idempotent ingest, with `resolved_person_id`/`resolved_company_id` set by ER, and
`match_links` recording which source records form which golden cluster + the merge survivor link
(`is_duplicate_of`) ([03:461–485](../03-database-design.md)). Crucially, **history lives in the log, so the
golden record does not need to be versioned to be auditable or time-travellable** — you reconstruct any past
belief by replaying `source_records` up to a timestamp. [06 §9:319](../06-enrichment-engine.md) already states
"`source_records` keeps every merge **reversible** (un-merge)."

### B.5 MDM golden-record / survivorship taxonomy

**[VERIFIED]** Mature MDM resolves conflicts with **per-attribute survivorship rules**, combined as a
cascade. The rule taxonomy:
[profisee.com — MDM survivorship](https://profisee.com/blog/mdm-survivorship/),
[dev3lop.com — survivorship rules](https://dev3lop.com/blog/master-data-survivorship-rules-implementation/).

| Rule | Picks the value that… | TruePoint signal |
|---|---|---|
| **Source priority / trust** | comes from the most authoritative source | provider trust order (`waterfall.ts`) |
| **Most recent** | was most recently observed/verified | `last_verified_at`, `source_records.ingested_at` |
| **Most frequent / corroborated** | the most sources agree on | `master_emails.source_count` ([03:446](../03-database-design.md)) |
| **Most complete** | has the fewest nulls (record-level tiebreak) | completeness sub-score (22/ADR-0025) |
| **Data-quality score** | scores highest on accuracy/conformity | `data_quality_score` ([03:403,420](../03-database-design.md)) |
| **Conditional** | satisfies if-then domain logic (e.g. human-entered > guess) | user-correction-outranks-provider rule |

**[VERIFIED]** Two non-obvious MDM points are load-bearing for us: (1) **attribute-level, not record-level** —
"build logic based on each attribute needed," because trusting a *whole record* from one source corrupts the
golden record; and (2) **cell-level survivorship requires content metadata per field** — *history* (every
value ever received + its source) and *lineage* (values that were at some point golden). Sources:
[profisee.com](https://profisee.com/blog/mdm-survivorship/),
[liliendahl.com — survivorship](https://liliendahl.com/2009/10/28/master-data-survivorship/).
TruePoint's golden formula already matches the cascade: "most-recent × most-corroborated × highest-trust
source" ([06 §9:315–316](../06-enrichment-engine.md)). The **content metadata per field** is the missing piece
(§C.4).

### B.6 Field-level provenance (the undesigned gap)

Synthesising §A (everyone merges per-field) + §B.5 (cell-level survivorship needs per-field content metadata):
the canonical model needs, **per field**, the answer to "where did this value come from, how confident, as of
when, corroborated by how many sources, and can a human override it?" Today TruePoint's provenance is
**batch/job-level only** — `source_imports`/`provider_calls` overlay-side, `source_records` master-side — with
**no per-field** `_source`/`_confidence`/`_observed_at` on `contacts`/`accounts` or the master records. This is
the explicit Phase-3 invention; **Phase 1 must reserve the seam** so the golden tables can carry it without a
later destructive migration.

---

## Part C — Mapping the patterns onto the TruePoint Layer-0 target

### C.1 Pattern → table map

| Pattern (Part B) | Where it lands in [03 §5.1](../03-database-design.md) | Status |
|---|---|---|
| Employment-as-edge (B.1) | `master_employment` (edge) + `master_persons.current_company_id` (denorm) | **Designed** ([03:413,428–436](../03-database-design.md)) |
| Valid-time interval (B.2) | `master_employment.started_on`/`ended_on`/`is_current`; channel `email_status` lifecycle | **Designed** for employment; **partial** for channels |
| Transaction-time (B.2) | `source_records.ingested_at` (evidence); **no** golden-row tx-time | **Evidence only** — golden tx-time deferred to provenance sidecar |
| Event-sourced log (B.4) | `source_records` (immutable, `content_hash`-idempotent) + `match_links` | **Designed** ([03:461–485](../03-database-design.md)) |
| Survivorship projection (B.5) | `master_persons`/`master_companies` = current-state golden rows | **Designed** (rows exist; merge engine is 06 §9) |
| Corroboration (B.5) | `master_emails.source_count` / `master_phones.source_count` | **Designed** ([03:446,457](../03-database-design.md)) |
| Company hierarchy (A.1/A.4) | `master_companies.parent_company_id` | **Designed** ([03:397](../03-database-design.md)) |
| Std. taxonomy (A.4/A.6) | `seniority_level` enum; `industry`/`name_normalized` | **Partial** (seniority closed; title/industry not yet taxonomy nodes) |
| Field-level provenance (B.6) | — none — | **UNDESIGNED — Phase 3; reserve seam in Phase 1** |

### C.2 The evidence-to-golden flow (event-sourced + survivorship)

```
  ingest (per source, immutable)        entity resolution               projection (current-state)
  ┌────────────────────┐   match_keys   ┌──────────────┐   cluster_id   ┌────────────────────┐
  │ source_records     │───────────────►│ match_links  │───────────────►│ master_persons /   │
  │  content_hash (UQ) │  determ. keys  │  cluster_id  │  survivorship  │ master_companies   │
  │  raw_data (jsonb)  │  + blocking    │  match_prob  │  (06 §9:315)   │ master_employment  │
  │  ingested_at       │  + Splink      │  review_st.  │                │ master_emails/phones│
  └────────────────────┘                │  is_dup_of   │                └─────────┬──────────┘
        (the LOG = system of record)    └──────────────┘                          │ per-field
                                                                                   ▼ (Phase-3 seam)
                                                                       ┌────────────────────────┐
                                                                       │ field provenance        │
                                                                       │ {field,source_record_id,│
                                                                       │  confidence, observed_at,│
                                                                       │  ingested_at, src_count} │
                                                                       └────────────────────────┘
```

The golden tables are a **materialised projection**; the **truth + full history is the `source_records` log**.
This is why we do **not** need SCD2 on the golden rows: time-travel and audit are answered by replaying the log
(matches [06 §9:319](../06-enrichment-engine.md) "every merge reversible").

### C.3 The constraints filter

Every candidate pattern must survive four TruePoint-specific constraints:

1. **Layer-0 is system-owned, NOT workspace-RLS-scoped** ([ADR-0021:33–35](../decisions/ADR-0021-global-master-graph-and-overlay.md),
   [03:55](../03-database-design.md)). The canonical model therefore carries **no `tenant_id`/`workspace_id`**
   and **no `owner_user_id`/`visibility`** — those are Layer-1 overlay columns
   ([03:503–506,540–543](../03-database-design.md)). Any provenance sidecar is likewise system-owned; isolation
   is by **access path** (masked search + paid reveal), never an RLS predicate. **This forbids any
   per-owner/per-workspace field in the canonical model** — a tempting but wrong "who revealed this value"
   column belongs on the overlay (`contacts.revealed_by_user_id`), not on `master_*`.
2. **Per-owner visibility is a Layer-1-only concern.** Survivorship/merge decisions are global and
   owner-blind; the overlay re-applies owner-scope at read. The canonical model must not leak a workspace's
   private edits into the golden record unless **CONTRIBUTE-TO** is opt-in
   ([ADR-0021:60–62](../decisions/ADR-0021-global-master-graph-and-overlay.md)).
3. **Billions-scale.** The golden tables are the hot OLTP + search-projection surface — they must stay
   **one lean current-state row per entity**, indexed by the deterministic keys
   (`primary_domain`, `linkedin_company_id`, `linkedin_public_id`, `email_blind_index`
   [03:716](../03-database-design.md)). Heavy/append-only history (`source_records`) is pushed to the
   **S3/Iceberg lake, range-partitioned by `ingested_at`** ([03:470](../03-database-design.md)); golden OLTP
   shards on Citus by entity/blocking key ([ADR-0021:75–77](../decisions/ADR-0021-global-master-graph-and-overlay.md)).
   This is the decisive vote **against** blanket SCD2/bitemporal on the golden rows.
4. **Field-level provenance is mandatory but undesigned.** It must be added without bloating the hot golden
   row (reference `source_record_id`; no PII in clear) and without an RLS column (system-owned).

### C.4 Why field-level provenance can't be retrofitted as an afterthought

If golden values are stored bare (no per-field source/confidence/observed-at), then: survivorship cannot be
**recomputed** when a higher-trust source arrives; a merge cannot be **reversed** at field granularity
(only whole-cluster, via `match_links`); the "user correction outranks provider guess" rule (per the brief's
provenance constraint) has nowhere to record that a field is human-pinned; and DSAR "where did this email come
from" is answerable only to batch granularity. Hence the Phase-1 recommendation must **explicitly reserve**
the field-provenance seam even though the structure is built in Phase 3.

---

## Part D — Tradeoff summary

| Approach | Correctness | Scale cost (billions) | History/time-travel | Reversible merge | Field provenance | Verdict |
|---|---|---|---|---|---|---|
| Person-as-node, no edge | low | lowest | none | n/a | none | **Reject** (= current gap) |
| Whole-record last-writer-wins golden | low | low | none | no | no | **Reject** (loses human edits) |
| SCD2 on golden rows | medium | **high** (write-amp, bloat) | valid-time | partial | no (unless added) | **Reject as blanket** |
| Full bitemporal on every attribute | highest | **highest** | both axes | yes | implicit | **Reject as blanket** |
| **Event-sourced log + survivorship-projected golden + selective valid-time on temporal edges + field-provenance sidecar** | high | **low golden / cold log** | replay log (both axes) | yes (log + match_links) | **yes (sidecar)** | **RECOMMEND** |

---

## Recommendation

**Adopt a layered, event-sourced canonical model — not a uniform temporal model — composed of four parts:**

1. **Employment-as-edge, affirmed.** Keep `master_persons` and `master_companies` as entity nodes and
   `master_employment` as the reified, attributed person↔company edge, with the current edge denormalised onto
   `master_persons.current_company_id` ([03:413,428–436](../03-database-design.md)). This is the market
   consensus (LinkedIn EG, Apollo job-change, ZoomInfo rollup — §A) and the temporal-KG standard (§B.1). It is
   the only shape that carries history, multi-affiliation, and per-edge provenance — the exact things the
   current overlay `contacts.account_id` single-FK cannot (`contacts.ts:98`).

2. **`source_records` is the system of record; the golden tables are a survivorship projection.** Treat
   `source_records` ([03:461–471](../03-database-design.md)) as the immutable, append-only, `content_hash`-
   idempotent event log, and `master_persons`/`master_companies`/`master_employment`/`master_emails`/
   `master_phones` as a **current-state materialised view** rebuilt by the ER + survivorship engine
   ([06 §9:305–325](../06-enrichment-engine.md)). Survivorship is **per-field, cascade-based**:
   most-recent × most-corroborated (`source_count`) × highest-trust source, with the conditional override that
   **human-entered values outrank provider guesses**. History and time-travel come from replaying the log — so
   the golden rows stay lean and un-versioned.

3. **Apply valid-time *selectively*, only where the domain is genuinely temporal** — the employment edge
   (`started_on`/`ended_on`/`is_current`, already present) and the contact-channel status lifecycle — using
   **close-don't-delete** (Graphiti-style edge invalidation, §B.2): a job change sets `is_current=false` +
   `ended_on` and opens a new edge; it never overwrites or hard-deletes. This buys Apollo-style job-change
   history without versioning the whole person row.

4. **Reserve the field-level-provenance seam now (build it in Phase 3).** The canonical model must be able to
   attach, per field, `{source_record_id, source_name, confidence, observed_at (valid-time), ingested_at
   (transaction-time), source_count, is_user_pinned}` — a **cell-level-survivorship content-metadata sidecar**
   (§B.5/B.6). Phase 1 should not finalise the golden DDL in a way that makes this a later destructive
   migration. This is the single biggest gap the market makes obvious (every competitor merges per-field;
   §A.7) and the one TruePoint has not yet designed.

All four parts stay **Layer-0 system-owned**: no `tenant_id`/`workspace_id`/`owner`/`visibility` columns on
any canonical or provenance table; isolation is by access path (masked search + paid reveal), and per-owner
visibility remains a Layer-1 overlay concern (§C.3).

### What this rejects, and why

- **Pure SCD Type 2 on the golden records — rejected.** It versions the hot OLTP/search-projection surface on
  every change (bloat + write-amplification at billions; §C.3 constraint 3) and captures only valid-time,
  while the `source_records` log already holds the full history more cheaply and with both time axes. Paying
  twice for worse coverage.
- **Full bitemporality on every attribute — rejected as a blanket policy.** Maximal correctness, maximal cost
  (two interval columns × every attribute, a new version per change). Justified only on the genuinely temporal
  edges/channels (where we *do* apply valid-time), not on every firmographic field.
- **Whole-record / last-writer-wins golden merge — rejected.** Violates the per-field survivorship mandate and
  silently destroys human corrections — the explicit anti-pattern in the provenance constraint; every
  surveyed platform merges per-field (§A.7).
- **Person-as-node with a single `current_company` and no edge — rejected.** It is literally the current
  overlay limitation (`contacts.account_id`): one company, no history, no multi-affiliation, no edge
  provenance.
- **Storing raw evidence inline on the golden row (no separate `source_records`) — rejected.** Without the
  immutable log, merges are irreversible, survivorship cannot be recomputed when a better source arrives, and
  DSAR lineage degrades — the very capabilities [ADR-0021](../decisions/ADR-0021-global-master-graph-and-overlay.md)
  and [06 §9](../06-enrichment-engine.md) promise.

**Implementation status (gap → work-to-do, not a license to skip a rule).** Only Layer 1 (the overlay,
without the `master_*_id` FKs) is built today (`packages/db/src/schema/contacts.ts`); the entire Layer-0
canonical model of this recommendation is **designed in [03 §5.1](../03-database-design.md) but not built**,
and **field-level provenance (part 4) is undesigned anywhere** — it is the Phase-3 deliverable for which Phase 1
must reserve the seam. None of these gaps relaxes the constraints: when built, every canonical table stays
system-owned (no RLS columns), survivorship stays per-field, and the deterministic resolution keys stay backed
by DB unique constraints ([03:716](../03-database-design.md)) so concurrent ingests cannot mint duplicates.
