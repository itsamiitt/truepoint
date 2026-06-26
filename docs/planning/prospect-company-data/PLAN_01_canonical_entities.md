# PLAN 01 — Canonical Entity Model (Layer-0 golden person + company)

> **Gate: PLAN · Phase 1 — Canonical Entity Model.** **Converts:**
> [BRAINSTORM_01_entity_options.md](./BRAINSTORM_01_entity_options.md) (the §4 **DECISION**: B's backbone +
> D's assertion ledger + C-selective) and [RESEARCH_01_entity_modeling.md](./RESEARCH_01_entity_modeling.md)
> (the **RECOMMENDATION**: event-sourced log + survivorship-projected golden + selective valid-time +
> field-provenance sidecar). **Inherits (verbatim, not re-litigated):** the spine
> [PLAN_00_constraints_and_scope.md](./PLAN_00_constraints_and_scope.md) constraints **C1–C10**, scope
> boundary (§2), vocabulary (§3), and the §8 required-sections checklist. **Ground truth:**
> [ADR-0021](../decisions/ADR-0021-global-master-graph-and-overlay.md) (two-layer model),
> [03 §5.1](../03-database-design.md) (the Layer-0 DDL this PLAN freezes — READ + CITE),
> [06 §9](../06-enrichment-engine.md) (the ER pipeline), [ADR-0015](../decisions/ADR-0015-entity-resolution-dedup-engine.md).
> **House style:** [list-plan/02-data-model.md](../list-plan/02-data-model.md). **No code, schema, SQL,
> migration, or settings are modified by this gate — only this file is written.**

---

## 0. Lineage — what this PLAN converts, and the one-line plan

`RESEARCH_01` surveyed the owned-graph market (ZoomInfo/Apollo/Clay/Clearbit/Cognism/LinkedIn EG, §A) and
the MDM/temporal-KG toolkit (§B), and **recommended** a layered, event-sourced model: `source_records` as the
immutable system of record, the `master_*` tables as a **lean survivorship projection**, valid-time applied
**selectively** to the genuinely temporal domains, and a **reserved field-provenance seam**
(`RESEARCH_01` Recommendation, parts 1–4). `BRAINSTORM_01` stress-tested four distinct shapes (A inline golden,
B episode-log, C blanket bitemporal, D assertion-ledger) against six axes and **decided** (§4): keep **B's
backbone** (the log + `match_links`), complete it with a **D-shaped per-cell assertion ledger** for field-level
provenance, and apply **C selectively** (valid-time on the employment edge + channel-status lifecycle only).

**This PLAN converts both into the concrete canonical-entity schema.** It traces directly: every schema
decision below names the brainstorm decision-clause (`BRAINSTORM_01 §4.1–§4.4`) or the research finding
(`RESEARCH_01 §B.x`/Recommendation) it crystallizes, and obeys the spine `PLAN_00` C1–C10. The one-line plan:

> **Freeze the `03 §5.1` Layer-0 entity tables as a lean, un-versioned, current-state *projection* keyed by the
> deterministic resolution uniques; treat `source_records` as the immutable system of record + `match_links` as
> the whole-entity cluster/merge substrate; apply valid-time only to the channel-status lifecycle (the edge is
> `PLAN_02`); and *reserve* — design now, build in Phase 3 — a system-owned, D-shaped `field_assertion` ledger
> as the field-level-provenance seam, so `source_count`, per-cell unmerge, recomputable survivorship, and
> cell-level DSAR all become additive, never a destructive backfill.**

---

## 1. Scope of this PLAN (entities; the edge is PLAN_02, the ledger build is PLAN_03)

> Per the spine, Phase 1+2 **co-land as one migration** (`PLAN_00 §7`: the edge FKs the entities, so they
> cannot release in separate steps without a broken intermediate). This PLAN owns the **entity tables**; the
> companion `PLAN_02` owns the **edge** + overlay back-refs + the resolution fallbacks.

| In this PLAN (entity grain) | Deferred to a sibling / scale track |
|---|---|
| `master_persons`, `master_companies` golden nodes (key columns, uniques, facets, indexes) | `master_employment` edge mechanics + `UNIQUE(person,company,started_on)` + `current_company_id` *population* (`PLAN_02`) |
| `master_emails` / `master_phones` channel records (blind-index unique, status, `source_count`) | overlay `contacts.master_person_id` / `accounts.master_company_id` back-refs + the C4 re-point cascade (`PLAN_02`) |
| `source_records` (immutable evidence, `content_hash` idempotency, partitioning) | free-mail/ISP exclusion + no-domain resolution fallback (S3) — ER-owned (`PLAN_02`) |
| `match_links` + **the `match_clusters` decision** (cluster identity at MVP) | the `field_assertion` ledger **BUILD** + the survivorship **merge engine** (U1–U4) (`PLAN_03`) |
| The **bi-temporal-vs-SCD decision** for the golden rows (§3) | Splink probabilistic tail + blocking/MinHash-LSH + Citus/OpenSearch/ClickHouse/Iceberg (**scale track**, C9) |
| The **ER integration contract** at the entity grain (§4) + the **`field_assertion` seam reservation** (§2.7) | the golden-cell rollup mechanism + ledger physical home (OQ2/OQ3 → `PLAN_03`/`PLAN_04`) |

`current_company_id` is a **column on `master_persons`** so it is named in §2.3, but it is *populated from the
`is_current` edge*, whose mechanics are `PLAN_02`. `master_*_id` is a **mutable pointer with a merge re-point
cascade** (`PLAN_00 C4`); the deterministic-only MVP **mints** duplicates that the deferred ER later **merges**
(`PLAN_00 C5/C9` mint-then-merge).

---

## 2. Target schema

### 2.1 The entity / evidence / ER-output shape (ASCII ER)

```
  LAYER 0 — system-owned, NOT workspace-RLS-scoped (isolated by access path — C7, §5)

  ┌────────────────────┐    current_company_id (denorm of is_current edge — PLAN_02)   ┌────────────────────┐
  │ master_persons     │──────────────────────────────────────────────────────────────►│ master_companies   │
  │  id (uuid v7) PK   │                                                                 │  id (uuid v7) PK    │
  │  linkedin_pub_id ◇ │   ◇ = UNIQUE deterministic resolution key                       │  primary_domain  ◇  │
  │  full_name (trgm)  │                                                                 │  alt_domains[]      │
  │  has_email/has_phone facets    is_suppressed    region/jurisdiction                  │  linkedin_co_id  ◇  │
  └───┬────────────┬───┘                                                                 │  name_normalized(trgm)
      │1           │1                                                                    │  parent_company_id ─┐ self-FK
      │N           │N                                                                    │  firmographics/tech │ │
  ┌───▼──────┐ ┌───▼──────┐                                                              └─────────┬───────────┘◄┘
  │master_   │ │master_   │  channels stay first-class (native source_count/status/freshness)      │
  │ emails ◇ │ │ phones ◇ │  ◇ = email_blind_index / phone_blind_index UNIQUE (GLOBAL dedup + DSAR) │
  └──────────┘ └──────────┘                                                                         │
                                                                                                    │
  ┌──────────────────────────┐  resolved_person_id / resolved_company_id (set by ER)  ───────────────┘
  │ source_records (the LOG)  │  ◇ content_hash UNIQUE = idempotent ingest · raw_data jsonb · match_keys jsonb
  │  immutable · ingested_at  │  range-partitioned by month → bulk to S3+Iceberg (scale track)
  └─────────────┬─────────────┘
                │ N
                ▼
  ┌──────────────────────────┐  cluster_id = the golden entity id (NO separate match_clusters at MVP — §2.6)
  │ match_links (ER output)   │  is_duplicate_of = survivor link → the C4 re-point cascade source (PLAN_02)
  └──────────────────────────┘

  ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
  │ [seam · designed here, BUILT in PLAN_03] field_assertion — D-shaped per-cell provenance ledger │
  │  {entity_type, entity_id, field, value_norm, source_name, source_record_id, confidence,        │
  │   observed_at (valid-time), ingested_at (tx-time), is_user_pinned, superseded_by}               │
  │  golden cell = survivorship rollup of its live assertions · source_count = COUNT(DISTINCT src)  │
  └──────────────────────────────────────────────────────────────────────────────────────────────┘
```

The golden rows are a **materialized current-state projection** (`BRAINSTORM_01 §4.2`); **truth + full history
live in `source_records` (raw) and the `field_assertion` ledger (derived per-cell)** — so the golden tables
stay one lean row per entity and are **never versioned** (§3).

### 2.2 `master_companies` — golden company node ([03:390–407](../03-database-design.md))

| PK | Key columns | Unique / FK | Index | Notes |
|---|---|---|---|---|
| `id` uuid v7 | `primary_domain` citext · `alt_domains` citext[] · `name` · `name_normalized` citext · `linkedin_company_id` · `parent_company_id` · `industry`/`sub_industry` · `employee_count`/`employee_band` · `revenue_range` · `technographics` jsonb · `hq_country`/`hq_city` · `data_quality_score` · `region`/`jurisdiction` | **`primary_domain` UNIQUE** (the strongest company key — PSL eTLD+1, signal #3); **`linkedin_company_id` UNIQUE**; `parent_company_id` → `master_companies(id)` (subsidiary→parent hierarchy) | `gin_master_companies_name` GIN+`pg_trgm` on `name_normalized` ([03:407](../03-database-design.md)) | `employee_band` is the **search facet** (`'11-50'`…), `employee_count` the raw value; `technographics` (BuiltWith/HG) and `alt_domains` (redirects/acquired brands/country TLDs) are first-class per `RESEARCH_01 §A.4`. `name_normalized` = legal-suffix-stripped + casefolded — the **no-domain fuzzy fallback** (signal #4/#5). |

**Decisions this PLAN freezes:** (1) `primary_domain` is **nullable** (a `citext UNIQUE` admits NULL) — a
**company-less or domainless company** (registry-only, stealth) is representable without a domain key
(`BRAINSTORM_01 §2 S3`); the free-mail guard that stops `gmail.com` minting a company is **ER-owned**
(`PLAN_02`), not a column constraint. (2) `industry`/`sub_industry`/`seniority` are **closed-vocabulary text**
today; promoting title/industry to **taxonomy nodes** (LinkedIn-EG `Title_*`/`Industry_*`, `RESEARCH_01 §A.6`)
is a **deferred refinement** (OQ4), not a Phase-1 column change. (3) `region`/`jurisdiction` (`char(2)`) carry
the residency facet used by `master_persons` and the reveal path — kept for data-residency policy, never an RLS
predicate (§5).

### 2.3 `master_persons` — golden person node ([03:409–426](../03-database-design.md))

| PK | Key columns | Unique / FK | Index | Notes |
|---|---|---|---|---|
| `id` uuid v7 | `linkedin_public_id` · `full_name`/`first_name`/`last_name` · `current_company_id` · `job_title` · `seniority_level` (enum) · `department` · `location_country`/`location_city` · `has_email`/`has_phone` facets · `data_quality_score` · `is_suppressed` · `region`/`jurisdiction` | **`linkedin_public_id` UNIQUE** (strongest person key, signal #1); `current_company_id` → `master_companies(id)` (denorm of the `is_current` edge) | `gin_master_persons_name` GIN+`pg_trgm` on `full_name` ([03:425](../03-database-design.md)); `idx_master_persons_company (current_company_id)` ([03:426](../03-database-design.md)) | `has_email`/`has_phone` are **precomputed boolean facets** so masked search never joins the channel tables at query time — and the channels' **PII is never reachable from the facet** (§5). `is_suppressed` mirrors the global suppression/objection state and **gates reveal** (08 §3) — set by the DSAR fan-out (§5.4). `seniority_level` CHECK ∈ `{c_suite,vp,director,manager,ic,other}`. |

**Decisions this PLAN freezes:** (1) the person carries **no inline email/phone** — channels are separate rows
(§2.4), so verification and freshness are per-channel facts (`RESEARCH_01 §A.5/§B.5`). (2) `current_company_id`
is the **only** company pointer on the person; *history + multi-affiliation* live on the `master_employment`
edge (`PLAN_02`), never as extra person columns — this is the rejection of person-as-node
(`RESEARCH_01 §B.1`, `PLAN_00 C2`). (3) the flat scalar attributes here (`job_title`, `seniority_level`,
`department`, names) are exactly the cells the **`field_assertion` ledger** (§2.7) will carry provenance for —
they are stored bare on the golden row (cheap read, A's read-shape) but **derived** from the ledger
(`BRAINSTORM_01 §4.2`).

### 2.4 `master_emails` / `master_phones` — verifiable channel records ([03:438–459](../03-database-design.md))

| Table | PK | Key columns | Unique / FK | Notes |
|---|---|---|---|---|
| `master_emails` | `id` v7 | `email_enc` bytea · `email_blind_index` bytea · `email_domain` citext · `email_status` (enum) · `source_count` · `last_verified_at` · `verification_source` · `is_primary` | **`email_blind_index` UNIQUE** (HMAC — **GLOBAL dedup + DSAR/suppression lookup key**); `master_person_id` → `master_persons(id)` `ON DELETE CASCADE` | `email_enc` is **encrypted**, revealed only inside the paid-reveal tx; `email_status` CHECK ∈ `{unverified,valid,risky,invalid,catch_all,unknown}`; `source_count` = corroboration (survivorship input, `RESEARCH_01 §A.2`). |
| `master_phones` | `id` v7 | `phone_enc` bytea · `phone_blind_index` bytea · `line_type` · `phone_status` · `source_count` · `last_verified_at` | **`phone_blind_index` UNIQUE** (HMAC over E.164); `master_person_id` → cascade | line type (`direct`/`mobile`/`hq`/`unknown`) + status; `phone_blind_index` is the dedup + DSAR key. |

**Decision this PLAN freezes (resolves `BRAINSTORM_01 OQ1 + OQ4):** the channel tables **keep their native
`source_count`/`last_verified_at`/`status` shape and are NOT folded into the generic `field_assertion`
ledger.** Rationale: (a) channels are *already* corroboration-aware and verification-lifecycle-aware — folding
them in would **double-store** corroboration (`BRAINSTORM_01 OQ1`); (b) channels hold **PII** (`*_enc` +
blind-index) — keeping PII in the channel tables means the flat-attribute ledger needs **no `value_enc` /
no per-assertion blind index** for the common case, which dissolves `OQ4` cleanly. The `field_assertion`
ledger therefore covers **only the flat scalar attributes** of `master_persons`/`master_companies`
(title, name, seniority, department, industry, `employee_band`, …); the channels remain the per-channel
provenance store. The channel-status **lifecycle** (`unverified → valid/risky/invalid/catch_all`) is where
valid-time is applied via **close-don't-delete** (§3), not the only place corroboration is counted.

### 2.5 `source_records` — the immutable evidence log (system of record) ([03:461–471](../03-database-design.md))

| PK | Key columns | Unique / FK | Partition | Notes |
|---|---|---|---|---|
| `id` v7 | `source_name` (`apollo\|zoominfo\|clearbit\|coop\|public_registry\|…`) · `content_hash` bytea · `raw_data` jsonb (verbatim payload) · `match_keys` jsonb (extracted normalized keys) · `resolved_person_id` · `resolved_company_id` · `lawful_basis_snapshot` jsonb · `region` · `ingested_at` | **`content_hash` UNIQUE** (`sha256(canonical payload)` → **idempotent ingest**); `resolved_*` → `master_persons`/`master_companies(id)` (set by ER) | **range-partition by `ingested_at` (month)** ([03:470,736](../03-database-design.md)); bulk → **S3+Iceberg** lake (scale track) | This is **B's backbone** (`BRAINSTORM_01 §4.1`): append-only, never destroyed, so merges stay reversible and survivorship is recomputable. `source_name` records **the channel, never a workspace** — CONTRIBUTE-TO co-op data enters as `source_name='coop'` (opt-in/off — `PLAN_00 C3`, `ADR-0021:60–62`); **MATCH-AGAINST writes no `source_records` row** (it only reads/links). |

### 2.6 `match_links` — ER output + the cluster-identity decision ([03:473–485](../03-database-design.md))

| PK | Key columns | Unique / FK | Index | Notes |
|---|---|---|---|---|
| `id` v7 | `entity_type` (`person\|company`) · `cluster_id` · `source_record_id` · `match_probability` numeric(4,3) · `match_method` · **`is_duplicate_of`** · `review_status` | `source_record_id` → `source_records(id)` `ON DELETE CASCADE`; `match_probability` CHECK ∈ [0,1]; `review_status` CHECK ∈ `{auto,pending,confirmed,rejected}` | `idx_match_links_cluster (entity_type, cluster_id)` ([03:485](../03-database-design.md)) | the row that says "this `source_record` belongs to this golden cluster, scored thus." |

**The `match_clusters` decision (resolves the task's `match_links/match_clusters` ambiguity).** ADR-0021:42
names `match_clusters`/`match_links`; the `03 §5.1` DDL ships **only `match_links`**. This PLAN **freezes that**:
at MVP **there is no separate `match_clusters` table — `match_links.cluster_id` IS the golden entity id**
(`master_persons.id` / `master_companies.id`). The golden row *is* the cluster's materialization, so a second
table holding only `(cluster_id, size, …)` would be a redundant denormalization to keep in sync. A future
`match_clusters` table (cluster-level metadata: member count, `last_resolved_at`, aggregate review state,
calibrated cluster confidence) is a **scale-track** affordance that arrives with the Splink tail (OQ5), not a
Phase-1 table.

**MVP exercises a strict subset** (`PLAN_00 §5.2` spine note): the MVP writes `match_method='deterministic'`,
`review_status='auto'`, and uses **only** the `cluster_id`/`is_duplicate_of` pair (the C4 re-point source).
`match_probability`, `match_method='splink'`, and `review_status∈{pending,confirmed,rejected}` (the
clerical-review queue, `06 §9:318`) are **scale-track** (C9) — the columns exist at freeze so the queue is an
additive switch-on, never a migration.

### 2.7 `field_assertion` — the D-shaped provenance ledger (designed here, **BUILT in Phase 3**)

> This is the **reserved seam** (`PLAN_00 C6`; `BRAINSTORM_01 §4.3`; `RESEARCH_01` Recommendation part 4). Phase
> 1 **designs its shape so the golden DDL freezes compatibly**; `PLAN_03` builds it + the survivorship engine.
> It is **Layer-0 system-owned** — no `workspace_id` (§5).

| PK | Key columns | Unique / FK | Partition | Notes |
|---|---|---|---|---|
| `id` v7 | `entity_type` (`person\|company`) · `entity_id` · `field` (`'job_title'\|'seniority_level'\|…`) · `value_norm` · `source_name` · `source_record_id` · `confidence` numeric(4,3) · `observed_at` (valid-time) · `ingested_at` (tx-time) · `is_user_pinned` bool · `superseded_by` uuid | **dedup unique `(entity_type, entity_id, field, source_name, value_hash)`** — a re-observation of the same value by the same source is a no-op/`source_count` touch, **not** a new row (the anti-explosion key, `BRAINSTORM_01 §1.D`); `source_record_id` → `source_records(id)`; `superseded_by` → self | append-mostly, **range-partition by `ingested_at`** (like `source_records`) | golden cell = **survivorship rollup** of live (`superseded_by IS NULL`) assertions per `(entity_id, field)`; `source_count(field) = COUNT(DISTINCT source_name)` of live assertions; per-cell unmerge = supersede the offending assertion + re-roll one cell; `is_user_pinned` = "human-entered outranks provider guess." |

**Why reserving the seam is the load-bearing Phase-1 act.** If the golden rows freeze with bare scalar columns
and **no** compatible provenance home, `PLAN_03` must rewrite every live `master_persons`/`master_companies`
row to attach provenance — a destructive backfill at billions (`RESEARCH_01 §C.4`). Reserving the
`field_assertion` shape now (an **additive table**, plus a documented `field` vocabulary that matches the golden
columns) makes Phase 3 purely additive. **What Phase 1 does NOT do:** it does not build the ledger, the rollup
projector (OQ2), or decide the ledger's physical home (Postgres-Citus vs Iceberg-mirror, OQ3) — those are
`PLAN_03`/`PLAN_04`. It only freezes the **contract**: golden cell = rollup of `field_assertion`; channels stay
native (§2.4); `source_name` never `source_workspace` (§5).

### 2.8 Small `[plan]` refinements flagged against the `03 §5.1` DDL

These are **reserved seams / index hints**, additive and non-destructive — called out so the schema freeze is
not later reopened:

- **`[plan-seam]` blocking-key columns (scale track, reserve now).** `03 §12:731` says ER blocking keys (e.g.
  `metaphone(last_name)+registrable_domain` for persons; name word-n-gram for companies) are *materialized
  columns with their own indexes*. Blocking/MinHash-LSH is **deferred** (C9), but the **column** is cheap to
  reserve at freeze and populate lazily, so the scale track switches blocking on without a destructive
  migration. Recommendation: reserve a nullable `block_key` (or a generated column) on `master_persons` and
  `master_companies`; **do not index it at MVP** (deterministic-only resolution doesn't read it).
- **`[plan]` `updated_at`/`created_at`** already present on `master_persons`/`master_companies`
  ([03:405,423](../03-database-design.md)); the channel/log tables carry only `created_at`/`ingested_at` (they
  are append-only) — correct as-is, no change.
- **`[plan]` covering index for masked search projection.** `03 §12:730` calls for `INCLUDE` covering indexes
  so the masked list projection is index-only; the exact covering set is a `PLAN_05` (read-path) decision, not
  frozen here — flagged so the entity DDL leaves room for it.

---

## 3. Bi-temporal vs SCD — the decision and its rationale

> **Required decision for this PLAN.** Traces to `RESEARCH_01 §B.2/§B.3/§D` and `BRAINSTORM_01 §1.C/§4.4`.

| Candidate | What it versions | Verdict | Why (cite) |
|---|---|---|---|
| **SCD Type 2 on the golden rows** | a new golden-row version per change (valid-time only) | **Rejected as blanket** | bloats the **hot OLTP + search-projection surface**, write-amplifies at billions, and only captures valid-time while `source_records` already holds full history more cheaply — paying twice for worse coverage (`RESEARCH_01 §B.3/§D`). |
| **Full bitemporality on every attribute** | two interval pairs × every attribute, a version per change | **Rejected as blanket** | maximal correctness, maximal cost; every "current value" read pays `DISTINCT ON` + double-interval predicate (`BRAINSTORM_01 §1.C` S1). Reinvents the ledger with heavier machinery. |
| **Event-sourced log + lean projection + *selective* valid-time + per-cell ledger** | nothing on the golden row; history in the log + ledger; valid-time only on temporal domains | **ADOPTED** | golden stays one lean current-state row (S1); history/time-travel = replay the log / re-roll the cell; both time axes live in the ledger per cell (`RESEARCH_01 §D`; `BRAINSTORM_01 §4`). |

**Where time physically lives (the decision, concretely):**

```
  axis                         home                                         applies to
  ───────────────────────────  ───────────────────────────────────────────  ─────────────────────────
  transaction-time (we knew)   source_records.ingested_at (evidence)         every observation
                               field_assertion.ingested_at (per cell)        every flat-attribute cell (Phase 3)
  valid-time (true in world)   field_assertion.observed_at (per cell)        every flat-attribute cell (Phase 3)
                               master_employment.started_on/ended_on/is_current  the employment EDGE (PLAN_02)
                               master_emails/phones status lifecycle (close-don't-delete)  contact CHANNELS
  ── the golden master_* rows themselves are UN-VERSIONED current-state ─────────────────────────────
```

So: **the golden `master_persons`/`master_companies` rows are never versioned.** Valid-time is applied
**selectively** — to the employment edge (`PLAN_02`) and the channel-status lifecycle — using
**close-don't-delete** (Graphiti-style invalidation, `RESEARCH_01 §B.2`): a job change sets `is_current=false`
+ `ended_on` and opens a new edge; a channel that goes invalid is **closed**, not deleted. General per-cell
time-travel ("what did we believe Jane's title was last March") falls out of `field_assertion`'s two time
columns **without** SCD2 on the person row (`BRAINSTORM_01 §4.4`). This is the **C-applied-selectively** clause
of the brainstorm decision, made physical.

---

## 4. Identity-resolution integration (deterministic → blocking/LSH → Splink → survivorship → golden)

> How the entity tables get *written*. The five-stage pipeline is `06 §9:305–325`; this PLAN states the
> **entity-grain contract** + what is MVP vs scale track (`PLAN_00 C5/C9`).

```
  source row ──► (1) NORMALIZE ──► (2) DETERMINISTIC ──► hit?  ──yes──► link to existing golden (write match_links, bump source_count)
  (sparse,       matchKeys.ts      email_bi / li_id /         │
   dirty)        (the ONE          E.164 / domain             └──no──► (3) BLOCKING + MinHash/LSH  ──► (4) SPLINK score ──► (5a) ≥hi: auto-merge
   normalizer,                                                         [SCALE TRACK — deferred C9]       (Fellegi-Sunter)    (5b) mid: review queue
   C5)                                                                                                                       (5c) <lo: MINT new golden
                                                                                                        └────────────────────────────► survivorship → golden cell
```

- **Stage 1 — Normalize (shipped, reused, single source).** `packages/core/src/enrichment/matchKeys.ts`
  `buildMatchKeys` ([:132–156](../../packages/core/src/enrichment/matchKeys.ts)) is the **only** normalizer
  (`PLAN_00 C5`; ADR-0037 forbids a parallel one): plus-stripped/lowercased email → HMAC `emailIndex`; PSL
  eTLD+1 `registrableDomain` ([:74–81](../../packages/core/src/enrichment/matchKeys.ts)); E.164 `toE164`;
  LinkedIn slug; canonical name+tokens. These map 1:1 onto the golden uniques (§2.2/§2.3/§2.4).
- **Stage 2 — Deterministic match (MVP, ~95% case, `06 §9:309`).** A `source_record`'s extracted keys probe the
  golden **unique constraints**: `master_emails.email_blind_index`, `master_persons.linkedin_public_id`,
  `master_phones.phone_blind_index`, `master_companies.primary_domain`/`linkedin_company_id`. A hit **links**
  (writes a `match_links` row with `match_method='deterministic'`, bumps channel `source_count`); a clean miss
  on **all** keys **mints** a fresh golden row (`PLAN_00` mint-then-merge). **The unique constraints are the
  concurrency guard** (`03:716`): two concurrent ingests of the same person cannot both insert — one wins, the
  other's `INSERT … ON CONFLICT` resolves to the existing row, so duplicates can only arise from *missing-key*
  cases, never races.
- **Stages 3–4 — Blocking/MinHash-LSH + Splink (SCALE TRACK, deferred — C9, `06 §9:311–314`).** The fuzzy tail
  (name+company variants, missing exact key) needs blocking to avoid O(n²) at billions and Splink
  (Fellegi-Sunter) to score. **Deferred**: at MVP the missing-key case **mints** rather than fuzzily merging,
  accepting a bounded duplicate population (`PLAN_00 §11.2` tolerated-duplicate budget) that the deferred ER
  later merges.
- **Stage 5 — Survivorship → golden cell (`06 §9:315`).** The golden value per field = **most-recent ×
  most-corroborated (`source_count`) × highest-trust source**, with the conditional override **human-entered
  outranks provider guess** (`is_user_pinned`, §2.7). At MVP a deterministically-minted master is a
  **golden-*shaped* row not yet survivorship-merged** (`PLAN_00 §3` vocabulary); the **merge engine that reads
  `field_assertion` and arbitrates conflicts is `PLAN_03`**. The two-threshold routing (auto-accept ≥ high,
  clerical review between, auto-reject < low; false-merge target ≤0.5%) is `06 §9:318` / scale track.

**Reversibility contract (entity grain).** A wrong **whole-entity** merge is undone via
`match_links.is_duplicate_of` (split the cluster, re-project two golden rows) — B's substrate, `06 §9:319`. A
wrong **per-cell** survivorship pick is undone by superseding the offending `field_assertion` and re-rolling
that one cell — D's substrate (`BRAINSTORM_01 §2 S6`). Phase 1 freezes both substrates; `PLAN_02` wires the
overlay re-point cascade (C4), `PLAN_03` wires the cell re-roll.

---

## 5. RLS policy implications

> **Required section.** The governing rule is `PLAN_00 C7` + `03 §9:698`: **Layer 0 is system-owned and NOT
> workspace-RLS-scoped; isolation is by access path, never an RLS predicate.**

1. **No `workspace_id` / `tenant_id` / `owner` / `visibility` on any table in this PLAN.** `master_persons`,
   `master_companies`, `master_emails`, `master_phones`, `source_records`, `match_links`, and the reserved
   `field_assertion` ledger carry **none** of the overlay's RLS columns (`PLAN_00 C7`; `ADR-0021:33–35`;
   `RESEARCH_01 §C.3` constraint 1). A workspace does **not own** a master row, so there is **no predicate to
   key a policy on** — isolation is **structural**, not declarative.
2. **Isolation by access path.** The `leadwolf_app` role gets **no direct `SELECT`** on any Layer-0 table
   (`03:698`, `PLAN_00 §6.2`). A workspace reaches the universe **only** through (a) the **masked search**
   projection — candidate IDs + non-PII facets (`has_email`/`has_phone`/`employee_band`/`region`); the
   `master_emails`/`master_phones` channel PII is **never returned by search** (`03:383–384`) — and (b) the
   **paid-reveal** path, a privileged tx that decrypts **one** channel value and copies it into the calling
   workspace's overlay. Only the **ER pipeline**, **search-sync**, and **reveal** services touch Layer 0, each
   under its own least-privilege role (`03:698`). The projection boundary is **built in `PLAN_04`**; this PLAN
   **forbids any interim grant** of a direct Layer-0 read to `leadwolf_app` (failure F3).
3. **The S2 trap — `field_assertion` must record `source_name`, never `source_workspace`** (`BRAINSTORM_01 §2
   S2`). The field-provenance layer wants to record "who told us this," and a CONTRIBUTE-TO upload *is* a
   source — but storing `source_workspace_id` would put a per-workspace dimension on a Layer-0 row, forcing
   either an RLS predicate (breaks C7) or a leak of one workspace's contribution identity into the golden value
   others read. **Rule:** provenance records `source_name` (`apollo|zoominfo|coop|public_registry|…`, mirroring
   `03:463`); co-op contributions enter as `source_name='coop'` (opt-in/off — `PLAN_00 C3`); **MATCH-AGAINST
   writes no provenance row at all** (only CONTRIBUTE-TO does).
4. **DSAR / deletion cascade — the unit of deletion is the golden identity.** A data subject is found by the
   **one** `master_emails.email_blind_index` (GLOBAL unique, `03:442`); erasure is the audited platform fan-out
   (`withPrivilegedTx`): tombstone the `master_persons` identity, cascade `master_employment`/`master_emails`/
   `master_phones` (FK `ON DELETE CASCADE`, `03:430–459`) and the entity's `field_assertion` rows, set
   `master_persons.is_suppressed=true` + insert a **GLOBAL-scope suppression** row (blocks re-import), then
   cascade **golden → `source_records` → every overlay copy** with a verification scan
   (`ADR-0021:129–131`; `PLAN_00 §6.4`). **The ledger makes DSAR *more* provable** — `field_assertion` answers
   "this value came from source X on date Y, here are the N corroborating assertions, all now tombstoned" at
   **cell** granularity (`BRAINSTORM_01 §2 S5`); the channel tables remain the PII home so the blind-index
   lookup is one indexed read.
5. **Isolation-test posture.** Layer-0 tables get **no two-tenant RLS itest** (there is no tenant scope to
   assert). Instead: (a) the **overlay** two-tenant isolation itest (`list-plan/02-data-model.md:48–65`) is
   **extended** by `PLAN_02` to assert the new `master_*_id` back-ref column does not let workspace A read
   workspace B's rows; and (b) a **new access-path itest** asserts `leadwolf_app` has **no direct grant** on
   any `master_*`/`source_records`/`match_links`/`field_assertion` table — the structural-isolation analogue of
   the RLS itest. **Security has final say** (`PLAN_00 C8` precedence): no Layer-0 integration convenience
   relaxes this.

---

## 6. Scale-gate analysis (what breaks first at 10x — and the fix)

> **Required section.** Target: millions of users, **billions** of golden rows. MVP runs on the existing
> single-Aurora stack (`PLAN_00 C9`); the gate asks which entity-layer component breaks first as the universe
> 10x's, and whether the fix is the already-deferred scale track.

| What breaks first | Why | Fix (deferred?) |
|---|---|---|
| **The `gin_trgm` fuzzy-name indexes** (`master_persons.full_name`, `master_companies.name_normalized`) | a trigram GIN over **billions** of rows is enormous and write-amplifying — every golden insert/update maintains a multi-posting-list GIN; at 10x it dominates write cost and bloat | **Deferred — C9.** User fuzzy search moves to **OpenSearch** (`03:732` "heavy faceted filtering is *not* served from Postgres"; `ADR-0021:72–73`). The Postgres trgm GIN is retained **only** as an ER blocking-candidate aid, and even that is superseded by **MinHash/LSH blocking** (`06 §9:311`) at billions. **Recommendation: do not build the trgm GIN as a user-search index — scope it to ER blocking, and gate it behind the scale track** (avoids paying GIN maintenance for a search path OpenSearch will own). |
| **The fuzzy-tail resolution** (missing exact key → O(n²) pairwise) | deterministic index hits are O(log n), but the no-exact-key tail compares against the whole graph without blocking | **Deferred — C9.** Blocking + MinHash/LSH candidate generation + Splink-on-Spark over the Iceberg lake (`06 §9:311–314`, `03:747`). MVP **mints** the tail (mint-then-merge), bounded by the tolerated-duplicate budget (`PLAN_00 §11.2`). |
| **Golden OLTP single-writer** | `master_*` on one Aurora writer caps write throughput as the universe grows (~500M golden rows, `03:763`) | **Deferred — C9.** **Citus shard** by a hash of the entity/blocking key, **co-locating** a cluster's `source_records` + `match_links` + golden row on one shard so resolution + reveal stay node-local (`03:744–746`). **Sharding-key finding (this PLAN):** distribute persons by `master_persons.id`, and co-shard `source_records`/`match_links`/`field_assertion` on the **person** distribution column; **companies are a *separate* distribution** — a `source_record` that resolves *both* a person and a company cannot co-locate with both, so company resolution does a **cross-shard reference-table lookup** (reference-table replicate `master_companies` if it stays small enough, else accept the cross-shard hop). This is the central Citus design constraint Phase-1's keys must not preclude — which is why the deterministic uniques (`linkedin_public_id`, `primary_domain`, blind-indexes) are global and shard-stable. |
| **`field_assertion` row count** (N entities × M fields × K sources × T re-obs) | the ledger is itself a billions→**trillions**-row table; naive recompute-on-insert is an N+1/write-amp disaster (`BRAINSTORM_01 §1.D`) | **Reserved design — Phase 3.** Append-mostly, **dedup-keyed `(entity,field,source,value_hash)`** so re-observations don't explode it, **range-partitioned by `ingested_at`**, golden-cell rollup refreshed **incrementally for the touched cell only** (OQ2). Physical home (Postgres-Citus vs Iceberg-mirror) is OQ3 → `PLAN_03`/`PLAN_04`. |
| **`source_records` append volume** | immutable per-source evidence at billions is a high-cardinality append on the OLTP surface | **In-scope partition + deferred lake.** Range-partition by `ingested_at`/month (`03:470,736`); bulk → **S3+Iceberg** (scale track, `03:747`). |
| **"Person at company with company traits" reads** | a join from person → company per row would N+1 at list scale | **In-scope denorm.** `master_persons.current_company_id` denormalizes the current edge (`03:413`); masked search **flattens** person+company into one doc so a single query answers the compound filter (`ADR-0021` search topology). |

**Verdict:** every first-breakage is **either** an in-scope denormalization/partition applied now **or** a
component the brainstorm/spine **already deferred** behind the C9 gate. The decisive Phase-1 call is the
**Citus sharding key** (person-distributed, company as a separate/reference distribution) and **scoping the
trgm GIN to ER blocking rather than user search** — both shaped *now* so the scale track is additive.

---

## 7. Failure modes

> **Required section.** Entity-layer failure modes; each names its mitigation + the constraint that owns it.

- **F1 — Deterministic-only mints duplicate masters (the A-killer).** Two source rows for one human with no
  shared exact key each mint a fresh `master_persons` (`BRAINSTORM_01 §1.A` killer carried forward). *Mitigation
  (C4):* `master_*_id` is a **mutable pointer**; the `match_links.is_duplicate_of` re-point cascade is designed
  day one (`PLAN_02`) and fires when the deferred ER merges. The tolerated pre-ER duplicate rate is a tracked
  metric (`PLAN_00 §11.2`). Without C4 this corrupts silently.
- **F2 — `source_count` drift / un-recomputable corroboration.** A bare integer `source_count` that the
  projector maintains can drift and **cannot be recomputed** without re-scanning payloads (`BRAINSTORM_01 §2
  S4`). *Mitigation:* the channel tables keep `source_count` natively (§2.4) **and** the flat-attribute
  corroboration is `COUNT(DISTINCT source_name)` over live `field_assertion` rows (recomputable by
  construction, Phase 3). No golden field stores a bare un-recomputable count.
- **F3 — A Layer-0 read leaks past the projection.** Granting `leadwolf_app` any direct `master_*` read "to
  make integration easier" exposes the un-masked universe to every workspace (`PLAN_00 F3`). *Mitigation
  (C7/§5):* structural — no direct grant; reads only via masked search + privileged reveal; a new access-path
  itest asserts the absence of the grant.
- **F4 — Free-mail/ISP domain mints a phantom company.** `gmail.com`/`outlook.com` flowing into the
  `registrable_domain` → company key would mint a "Gmail employs 2 billion people" super-cluster
  (`BRAINSTORM_01 §2 S3`). *Mitigation:* `master_companies.primary_domain` is **nullable** (a person can be
  company-less); the **free-mail exclusion list** lives in the ER layer (`PLAN_02`) — the entity model **must
  not assume a domain exists**. Phase-1 contract: never auto-mint a `master_companies` row from a free-mail
  domain.
- **F5 — Provenance retrofit becomes a destructive backfill.** If the golden DDL freezes with no compatible
  provenance home, `PLAN_03` rewrites live golden rows (`RESEARCH_01 §C.4`). *Mitigation (C6/§2.7):* reserve the
  `field_assertion` shape + the `field` vocabulary at freeze; Phase 3 is purely additive.
- **F6 — Bulk-vs-batch normalizer drift.** A second normalizer for the bulk/ER path diverges from
  `matchKeys.ts`, producing inconsistent keys → split clusters (`ADR-0037:75–81`). *Mitigation (C5/§4):* single
  canonical `matchKeys.ts`; no parallel normalizer.
- **F7 — A separate `match_clusters` table drifts from the golden row.** If a `match_clusters` table is
  introduced prematurely it must be kept in sync with the golden row it mirrors. *Mitigation (§2.6):* MVP has
  **no** `match_clusters`; `cluster_id` **is** the golden id — single source of cluster identity.
- **F8 — Concurrent ingest double-inserts a duplicate.** Two workers resolve the same person at once.
  *Mitigation (§4):* the **global unique constraints** (`email_blind_index`, `phone_blind_index`,
  `linkedin_public_id`, `primary_domain`, `content_hash`) are the concurrency guard (`03:716`) — `INSERT … ON
  CONFLICT` makes the loser resolve to the existing row; duplicates can only arise from *missing-key* cases
  (F1), never races.

---

## 8. Open questions (carried into the PLANs)

> Inherited from `BRAINSTORM_01 §"Open questions"` and `PLAN_00 §11`, narrowed to this PLAN's grain + assigned.
> Some are **resolved by this PLAN** (noted); the rest are routed.

1. **OQ1 (resolved here).** Channel tables keep native `source_count`/`status`; the generic `field_assertion`
   ledger covers **only flat scalar attributes** — channels are **not** double-stored (§2.4).
2. **OQ4-encryption (resolved here).** PII stays in the channel tables (`*_enc` + blind-index); the
   flat-attribute ledger needs **no `value_enc`** in the common case (§2.4).
3. **OQ2 — golden-cell rollup mechanism (→ `PLAN_03`).** Trigger-on-insert vs incremental materialized view vs
   CDC/outbox-driven projector (`ADR-0035`)? What bounds rollup-refresh fan-out so one high-corroboration cell
   isn't an N+1? *This PLAN fixes the contract (golden cell = rollup of live assertions, refreshed for the
   touched cell only); the mechanism is `PLAN_03`.*
4. **OQ3 — `field_assertion` physical home (→ `PLAN_03`/`PLAN_04`).** Postgres (Citus-sharded, person-co-located
   per §6) for simple recompute, or S3/Iceberg with only the **winning** assertion mirrored to Postgres for the
   hot read? Cheaper at trillions vs slower per-cell audit.
5. **OQ5 — `match_clusters` promotion (→ scale track).** When the Splink tail lands, does cluster-level metadata
   (member count, calibrated cluster confidence, aggregate review state) justify a real `match_clusters` table,
   or does it stay denormalized onto the golden row? (§2.6.)
6. **OQ6 — title/industry taxonomy nodes (→ deferred refinement).** Promote `job_title`/`industry` from
   closed-vocabulary text to **reified taxonomy entities** (LinkedIn-EG `Title_*`/`Industry_*`,
   `RESEARCH_01 §A.6`) so faceting + ER key off the same node? Affects `master_persons`/`master_companies`
   columns — a future additive change, not a Phase-1 freeze.
7. **OQ7 — `is_user_pinned` under CONTRIBUTE-TO (→ `PLAN_03`).** A human correction is the highest-trust
   assertion, but if it originates in a workspace it must enter Layer 0 as `source_name='coop'` (opt-in). How is
   "human-pinned" reconciled so an **un-contributed** workspace edit pins the **overlay** cell without touching
   the golden cell? (Ties C3 to the ledger.)
8. **OQ8 — blocking-key column reservation (→ scale track).** Reserve `block_key` on
   `master_persons`/`master_companies` at freeze (cheap, avoids a later migration, §2.8) vs add it with the
   scale track? *This PLAN recommends reserving the column unindexed now.*

---

## 9. Pre-build thinking pass (entity grain — the items that bind)

> `PLAN_00 §8` ran the full pass at the spine level; this re-runs the items most specific to the canonical
> entities.

1. **Source of truth.** `source_records` (raw) + `field_assertion` (derived per-cell) are the system of record;
   `master_*` are a **lean current-state projection** (`BRAINSTORM_01 §4.2`). The initiative **inverts**
   today's overlay-is-truth (`PLAN_00 C1`).
2. **Failure modes / idempotency.** Ingest is idempotent on `source_records.content_hash` (UNIQUE, `03:464`);
   resolution is idempotent on the golden uniques + the `field_assertion` dedup key
   `(entity,field,source,value_hash)`; mint-then-merge is the accepted non-idempotency of *identity* that C4
   repairs.
3. **Duplicate prevention.** Global uniques `linkedin_public_id`/`primary_domain`/`linkedin_company_id`/
   `email_blind_index`/`phone_blind_index` (`03:716`) are the concurrency guard (F8); the missing-key tail is
   tolerated + merge-repaired (F1).
4. **Audit / change history.** `source_records` is master lineage; **per-field change history is the
   `field_assertion` invention** (Phase 3) — today there is no per-field "when did this title change and from
   what" (`RESEARCH_01 §B.6`).
5. **Security / field exposure.** No RLS columns on Layer 0 (§5); channel PII (`*_enc`) never reachable from the
   `has_email`/`has_phone` facet or from search (`03:383–384`); a `master_person_id` the client may eventually
   see (via the overlay) is an opaque pointer, never a Layer-0 read grant.
6. **Scalability.** Denormalize `current_company_id` + flatten person+company in the search doc (§6); the trgm
   GIN is scoped to ER blocking, not user search; `source_records` + `field_assertion` are partitioned + cold;
   bulk resolution is a JOB (BullMQ), never the request thread.
7. **Rollback.** The whole canonical model is **additive new tables** → reversible; the import-path
   MATCH-AGAINST is flag-gated (a bad resolver turns off without orphaning anything, since overlays keep their
   legacy `account_id`).
8. **Edge cases.** Company-less / domainless person (no edge, `current_company_id=NULL`, no company key —
   resolves on email/LinkedIn/fuzzy, F4); free-mail domain (never mints a company, F4); concurrent enrichment
   (uniques prevent double-insert, F8); job change (edge `ended_on` + new `is_current` — `PLAN_02`, never a
   silent person-row overwrite).
9. **Worst case.** Deterministic-only mints a large duplicate population the deferred ER must merge, firing a
   large C4 re-point cascade → contained by the mutable pointer + monitored async sweep, bounded by the
   tolerated-duplicate budget (`PLAN_00 §11.2`).

---

> **PLAN status.** This document freezes the **canonical entity model** (Phase 1) of the prospect↔company data
> initiative. It traces to the **DECISION** (`BRAINSTORM_01 §4`: B's backbone + D's assertion ledger +
> C-selective) and the **RECOMMENDATION** (`RESEARCH_01`: event-sourced log + survivorship-projected golden +
> selective valid-time + reserved field-provenance sidecar), and obeys the spine constraints `PLAN_00 C1–C10`.
> **Implementation status (gap → work-to-do, never license to skip a rule):** the entire Layer-0 entity model is
> **designed in [03 §5.1](../03-database-design.md) but not built** (only the Layer-1 overlay exists, without
> the `master_*_id` FKs — `contacts.ts:98` is still the single direct `account_id`); the `field_assertion`
> ledger is **undesigned-elsewhere and reserved here**, **built in `PLAN_03`**. None of these gaps relaxes a
> constraint: when built, every canonical and provenance table is **system-owned** (no RLS columns, C7),
> survivorship stays **per-field** (the ledger, recomputable), corroboration stays **recomputable**, and the
> deterministic resolution keys stay backed by **DB unique constraints** (`03:716`) so concurrent ingests cannot
> mint duplicates. The edge (`master_employment` + overlay back-refs) co-lands via `PLAN_02`; the projection
> boundary is built by `PLAN_04`.
