# Phase 5 — Read Path, Search & Caching: PLAN

> **Gate: PLAN.** Phase 5 of the prospect↔company data initiative — the **read path**: how the flattened
> "person at a company with these company traits" card is physically served across the two surfaces, kept fresh
> from Postgres truth, faceted at billions, paginated by keyset, cached without staleness on money/permission,
> and re-authorized at read. This gate freezes: the **routing table** (surface × query-class → substrate ×
> engine × consistency tier), the **global masked golden doc** OpenSearch mapping (field list + analyzers +
> suggesters), the **overlay browse** substrate (Postgres projection today → Typesense at scale), the
> **ClickHouse** facet store + exact-count contract, the **Redis** facet/suggest cache (deterministic keys,
> per-type TTL, single-flight/jitter, version-stamp invalidation), the **search-sync worker** that drains the
> `search_outbox` `PLAN_03 §1.3` already emits + the **hot-company restamp bound**, the **RYOW** routing rule,
> the **reconcile/divergence** detector, and the **`SearchPort`** adapter seams. **Converts:**
> `BRAINSTORM_05_read_options.md §4` — the DECISION *"a surface-and-query-class composite: serve global browse
> from the search index (C) over a flattened, masked, low-churn golden doc; serve overlay browse from the
> overlay read model (B-in-Postgres today / Typesense at scale, RLS-scoped); and serve every single-record
> detail, reveal, read-your-own-write, and money/permission decision from a live Postgres read (A) against
> truth"* — and `RESEARCH_05_read_path.md §Recommendation` — the RECOMMENDATION *"adopt a two-surface,
> search-index-as-read-model design — flatten the low-churn golden person+company traits into one masked
> OpenSearch document, keep all high-churn per-tenant state on the RLS overlay, serve exact load-bearing counts
> from ClickHouse, cache facet counts in Redis with stampede defenses, page with `search_after`+PIT, and
> re-check every permission and every charge against Postgres truth at read."* It answers the eight
> `BRAINSTORM_05 §4` open questions (OQ1–OQ8) inline and re-lists them in **Open questions**. **Depends on /
> cites:** `PLAN_00_constraints_and_scope.md` (C1–C10), `PLAN_02_affiliation_edge.md` (the edge +
> `current_company_id` derived cache), `PLAN_03_merge_and_provenance.md` (the `search_outbox` + the materialized
> scalar OV the index reads — never the map), `PLAN_04_tenant_owner_views.md` (`revealed_channels`, the read-seam
> rule, masked-search/paid-reveal as the only two Layer-0 paths), the planned DDL (`03-database-design.md:386-557,690-753`),
> ADR-0021/0035/0024/0002, `02-architecture.md:162-171`, `24-advanced-search-exploration-ux.md §5-§7`,
> `searchRepository.ts:257-403`, `packages/types/src/search.ts:152-197`, `packages/search/src/index.ts:1-6`.
> **No code, schema, SQL, index mapping, or settings are modified by this gate — only this file is written; the
> mappings/DDL below are the Phase-5 freeze (a target landing additively on the `PLAN_01`+`PLAN_02`+`PLAN_03`+`PLAN_04`
> co-land), not an applied change.**

---

## 0. Lineage — what this PLAN converts and freezes

`RESEARCH_05` surveyed Apollo (denormalize-then-join → reindex-storm → Siren query-time join at 350 nodes),
ZoomInfo (Solr JSON facets), and the CQRS / search-index-as-read-model consensus, and recommended a
**two-surface, flatten-the-low-churn-traits** design. `BRAINSTORM_05 §4` stress-tested three *substrates* — **A**
live SQL join per request, **B** Postgres projection/MV, **C** search-index-as-read-model — against seven scale
axes (S1–S7) + five constraints (C1–C5) and decided **not one substrate but a surface-and-query-class
composite**: global browse from **C**, overlay browse from **B** (Postgres→Typesense), and detail/reveal/RYOW/
money/permission from **A** (live Postgres). This PLAN is the **paving** of that road. It does four things:

1. **Freezes the routing table** (§1) — every read names its surface, query class, substrate, engine, and
   consistency tier; this is the artifact §2 builds against and the thing reviewers check a new endpoint against.
2. **Freezes the read substrates** (Target schema) — the global masked OpenSearch doc + mapping (OQ1), the
   overlay projection + Typesense cutover (OQ2), the ClickHouse facet store + exact-count MVs (OQ4), the Redis
   cache key/TTL/stampede policy (OQ5), and the `search_outbox`-driven **search-sync worker** + restamp bound
   (OQ3), all behind the existing `SearchPort` seam (OQ8).
3. **Freezes the consistency machinery** (§1.1, §2.6) — the RYOW routing rule (OQ6) and the reconcile/divergence
   detector (OQ7) that make the derived stores honest and rebuildable-from-truth.
4. **Freezes the boundaries** — masked-vs-revealed field split (the index *never* holds an encrypted channel),
   Layer-0 access-path isolation vs Layer-1 RLS, permission/charge re-check at read, scale-gate, failure modes.

> **Trace, explicit.** Every choice below names the `BRAINSTORM_05 §4` DECISION part (1–6) or `RESEARCH_05`
> recommendation point (1–7) it crystallizes, and each `BRAINSTORM_05 §4` open question (OQ1–OQ8) is resolved
> inline. Reuse is mandatory and the read path is **downstream**, never a re-architecture: it indexes the
> materialized scalar OV columns `PLAN_03` decided (never the `field_provenance` map — `PLAN_03 §3.2`), reads
> `current_company_id` as the derived cache `PLAN_02 §2.2` recomputes, hydrates PII only from `revealed_channels`
> `PLAN_04 §0.3`, drains the `search_outbox` `PLAN_03 §1.3` already emits, and extends the shipped keyset
> `searchRepository` (`searchRepository.ts:245-403`) + `SearchPort` (`search.ts:192-197`) rather than forking
> them. No second source of truth (C1); security has final say (CLAUDE.md precedence).

---

## 1. The routing table (the artifact everything else builds against)

The read path is **two surfaces × three query classes** (`BRAINSTORM_05 §0`, `RESEARCH_05 §C.1`). Picking one
substrate for the whole matrix is the trap the brainstorm exists to prevent. The freeze (refining
`BRAINSTORM_05 §4` part 1):

| Surface | Query class | Substrate | Engine | Consistency tier | Cache |
|---|---|---|---|---|---|
| **Global** (Layer 0, access-path) | browse / filter | **C** flattened masked doc | OpenSearch `master_persons_v1` (§2.2) | Tier 3 eventual (< 5 s CDC) | results uncached; PIT-scoped |
| **Global** | typeahead / suggest | **C** | OpenSearch suggesters (§2.2) | Tier 3 | Redis, TTL 300 s (§2.5) |
| **Global** | facet counts (browse) | **C** | OpenSearch terms aggs (approx) **or** ClickHouse | Tier 3 | Redis, TTL 30–60 s + jitter (§2.5) |
| **Global** | **select-all-N total** (credit spend) | **C** | **ClickHouse MV (exact)** (§2.4) | Tier 3, **exact as-of `doc_version`** | **never cached** for the take; cacheable for display |
| **Global** | record detail / **reveal** | **A** live Postgres (in-tx, `leadwolf_reveal`) | Postgres + `master_emails`/`revealed_channels` | **Tier 1 strong** | never cached |
| **Overlay** (Layer 1, RLS) | browse / filter / facet | **B** projection | Postgres `searchRepository` (≤ threshold) → Typesense (§2.3) | Tier 2/3 | Redis, per-ws version-stamped (§2.5) |
| **Overlay** | detail / **just-mutated row (RYOW)** | **A** live Postgres | Postgres (`withTenantTx`) | **Tier 2 strong** | never cached |
| **Any** | credit balance / suppression / permission | **A** in-tx, **uncached** | Postgres (`FOR UPDATE` / `assertNotSuppressed`) | **Tier 1 strong, never cached** | **forbidden** |

This crystallizes DECISION parts 1–6: C wins global browse (S1/S2/S6/S7), A is retained narrowly for
detail/RYOW (the carve-out C structurally requires), B is the overlay substrate + C's feed, exact counts come
from ClickHouse where money depends (S7), and nothing on a money/permission path is cached (C4). The
load-bearing reframe (`BRAINSTORM_05 §3`): A is rejected *as the browse default* and **right as the detail
substrate**; the surfaces and classes A serves are precisely the ones C carves out, and vice-versa.

### 1.1 Consistency tiers + RYOW routing (OQ6)

Three tiers (`RESEARCH_05 §B.6`), assigned per row of the table above:

- **Tier 1 — strong, in-tx, uncached.** Credit decrement (`FOR UPDATE`, `03:686`), suppression/DNC gate
  (`assertNotSuppressed`, `02 §3.1:104`), reveal ownership write, the decrypt of a `master_*` channel. **Never
  cached, never indexed** (`ADR-0024:29`; `PLAN_04 §0.4`).
- **Tier 2 — read-your-own-write, Postgres direct.** Record detail (open a contact → `contacts ⋈
  revealed_channels`, RLS-local, `PLAN_04 §0.3`); the overlay row the user **just** mutated (revealed/edited/
  added-to-list).
- **Tier 3 — eventual, < 5 s.** Global + overlay browse, facet counts, typeahead — the derived index/projection.

**The RYOW routing rule (OQ6 resolved).** Two mechanisms, no ambiguity:

1. **Detail is always Postgres.** Any single-record open / expand / hydrate reads Postgres (Tier 1/2), never the
   index — the index is masked + PII-free + eventually consistent, so it *cannot* serve the revealed cell
   (`PLAN_04 §0.3`; C3). This needs no marker: detail simply does not route to the index.
2. **Overlay browse within a write window falls back to Postgres.** On any overlay mutation the API stamps a
   short per-`(workspace_id,user_id)` marker `ryow:{ws}:{user}` in Redis with a window **≥ the CDC freshness SLO
   plus margin (10 s; SLO is < 5 s, `ADR-0024:25`)**. While the marker is live, the user's *overlay* browse/list
   read routes to the live `searchRepository` Postgres path (Tier 2 strong) instead of the Typesense projection;
   on expiry it returns to the index. The just-revealed cell additionally updates live over SSE
   (`24 §7.5:277`; `02 §3.4`) regardless of the marker.
3. **Global browse is always eventual.** You cannot read-your-own-write a billions-row shared index
   synchronously; a bulk import/reveal that mutated the global graph shows the **"indexing N rows…" honesty
   indicator** (`24 §5.1:226-228`), never a silently-incomplete result. The user's *own* just-revealed contact is
   read from the overlay (Postgres), not the global index.

The boundary, stated once: **"the row I just touched" → Postgres; "browse the list" → index, except the overlay
browse during the RYOW window.** This is the CQRS pattern — route the writer's immediate read to the write
store, be honest otherwise (`RESEARCH_05 §A.3, §B.6`).

---

## Target schema

The read path adds **no new authoritative store** (C1) — its artifacts are (a) derived index/columnar
projections, (b) one system-owned feed table (`search_outbox`) + one drain-cursor table, and (c) a Redis cache
namespace. Postgres golden (`master_*`) + overlay (`contacts`/`revealed_channels`) remain the only truth; every
artifact below is **rebuildable from them by re-driving the feed** (§2.6, OQ7).

### 2.1 `search_outbox` + `search_sync_state` — the dirty-entity feed (freeze; emitted by `PLAN_03 §1.3`)

`PLAN_03 §1.3` step 5 already enqueues a `search_outbox(...)` row from the **survivorship re-projection
worker** — *after* it has rebuilt the scalar OV columns + recomputed `current_company_id` in the same tx. Phase 5
**owns the consumer**, so it freezes the row shape. Choosing the **transactional outbox** (entity-level dirty
markers written by the projector that already knows which entity changed) over raw Debezium WAL-tailing is
deliberate: the flatten needs an *entity*, post-projection and coherent with the edge recompute — tailing raw
column changes would re-introduce the "person at the wrong company" ordering hazard (`PLAN_02 §4`,
`RESEARCH_02 §2.5`). Debezium/logical-replication (`02 §3.3:164`) remains the infra alternative behind the same
worker, but the outbox is the chosen feed.

```sql
-- System-owned (NO workspace_id-as-RLS-key — Layer-0 rows have none); drained ONLY by the search-sync role.
-- Co-located with the projection_outbox (PLAN_03 §1.3); same single-flight + coalescing discipline.
CREATE TABLE search_outbox (
  seq          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- monotonic drain cursor (global order)
  entity_type  varchar(20) NOT NULL
                 CHECK (entity_type IN ('person','company','company_employees','overlay_contact')),
  entity_id    uuid NOT NULL,                                     -- master_person_id | master_company_id | contacts.id
  op           varchar(8) NOT NULL CHECK (op IN ('upsert','delete')),
  doc_version  bigint NOT NULL,        -- monotonic per-entity version (from prov_hwm, PLAN_03 §3.2) → OpenSearch external version
  workspace_id uuid,                   -- NULL for Layer-0 (person/company/company_employees); set for overlay_contact
  enqueued_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_search_outbox_drain ON search_outbox (seq);      -- the worker reads in seq order from its cursor

-- Per-(index, shard) drain cursor + lag = the C1 "rebuildable from truth" operability handle (OQ7).
CREATE TABLE search_sync_state (
  sink         varchar(40) NOT NULL,   -- 'opensearch:master_persons_v1' | 'clickhouse:person_facets' | 'typesense:ws'
  shard_key    int NOT NULL DEFAULT 0, -- Citus shard / parallel-drain lane
  last_seq     bigint NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sink, shard_key)
);
```

- **`doc_version` is the last-write-wins guard.** The worker writes the OpenSearch doc with **external versioning
  `version=doc_version, version_type=external`** and the ClickHouse row with the same version (ReplacingMergeTree
  on `doc_version`), so an out-of-order or re-delivered drain can **never overwrite a newer doc with a staler one**
  — idempotent by `(doc id, version)` (`RESEARCH_05 §C.6.2`). This is the dropped/duplicate-event mitigation.
- **`op='delete'` is the suppression/erasure path.** When `master_persons.is_suppressed` flips true (`03:421`) or
  a DSAR erasure tombstones the identity (`PLAN_04 §RLS-3.5`), the projector enqueues `op='delete'` → the worker
  removes the doc from OpenSearch + ClickHouse so the suppressed/erased identity is **not even findable** (the
  facet/aggregate-leakage threat, `RESEARCH_04 §3.4`; DECISION part 6).
- **`company_employees` is the bounded hot-company fan-out marker** (§2.6) — one O(1) outbox row that the worker
  expands into a coalesced `_bulk` re-index of the company's *current* employees, never an N-row enqueue.

### 2.2 The global golden doc — OpenSearch `master_persons_v1` mapping (OQ1, the load-bearing one)

One flattened, **masked**, low-churn document per `master_persons` identity (DECISION part 2; `RESEARCH_05 §C.2`).
`_id = master_person_id`. It carries person facets + channel-presence booleans + **current-company firmographics**
(via the `current_company_id` derived cache, `03:413`, `PLAN_02 §2.2`) so "person at a company with these traits"
is **one lookup, no query-time join** (S1/S2). It indexes the **materialized scalar OV** the survivorship cascade
decided — **never** the `field_provenance` map (`PLAN_03 §3.2`: "the search/read path never touches the map").

| Doc field | Source column | OS type | Role | In doc? |
|---|---|---|---|---|
| `full_name` | `master_persons.full_name` (`03:412`) | `text` + `.suggest` (edge-ngram) | full-text + typeahead | yes |
| `first_name` / `last_name` | `03:412` | `keyword` | filter | yes |
| `job_title` | `master_persons.job_title` (`03:414`) | `text` (synonym_graph search analyzer) | full-text | yes |
| `canonical_title_id` | index-time canon (`ADR-0035:39-42`) | `keyword` `LowCardinality` | **facet** (collapses 30 spellings of CEO) | yes |
| `title_function` | derived (`search.ts:38-54`) | `keyword` | facet | yes |
| `seniority_level` | `master_persons.seniority_level` (`03:415`) | `keyword` | facet | yes |
| `department` | `03:417` | `keyword` | facet | yes |
| `location_country` / `location_city` | `03:417` | `keyword` | facet | yes |
| `has_email` / `has_phone` / `has_linkedin` | precomputed booleans (`03:418-419`) | `boolean` | facet — **no join** | yes |
| `current_company_id` | `master_persons.current_company_id` (`03:413`) | `keyword` | filter + detail link | yes |
| `company_name` | `master_companies.name` (`03:394`) | `text` + `keyword` | full-text + facet | yes (flattened) |
| `company_primary_domain` | `master_companies.primary_domain` (`03:392`) | `keyword` | facet (strongest company key) | yes |
| `company_industry` / `company_sub_industry` | `03:398` | `keyword` `LowCardinality` | facet | yes |
| `company_employee_band` | `master_companies.employee_band` (`03:399`) | `keyword` | facet ("band is the search facet") | yes |
| `company_revenue_range` | `03:400` | `keyword` | facet | yes |
| `company_technographics` | `03:401` | `keyword[]` | facet (terms / `?\|` overlap) | yes |
| `company_hq_country` | `03:402` | `keyword` | facet | yes |
| `data_quality_score` | `master_persons.data_quality_score` (`03:420`) | `integer` | range filter / sort | yes |
| `freshness_status` | Phase-6 (`22`, `RESEARCH_06 §1`) | `keyword` | facet / badge | yes |
| `region` / `jurisdiction` | `03:422` | `keyword` | **residency filter** (`03:422`) | yes |
| `doc_version` | `search_outbox.doc_version` | `long` | external version (LWW) | meta |
| **`email_enc` / `phone_enc` / any PII** | `master_emails`/`master_phones` (`03:438-459`) | — | — | **NEVER** (C3/C4) |
| **`workspace_id` / `owner_user_id` / `priority_score` / `outreach_status` / list membership** | overlay (`03:503-505,534-538`) | — | — | **NEVER** (the Apollo fix, S3/S6) |

```jsonc
// master_persons_v1 — index settings (abridged); blue/green behind the alias `master_persons` (OQ7 reindex)
{ "settings": { "index": { "number_of_shards": 24, "refresh_interval": "5s" },   // sized for billions (03:749)
    "analysis": { "filter": { "tp_synonyms": { "type": "synonym_graph",          // query-time, editable w/o reindex (ADR-0035:37)
        "synonyms_path": "analysis/title_synonyms.txt" } },
      "analyzer": { "tp_search": { "tokenizer": "standard",
        "filter": ["lowercase", "tp_synonyms"] } } } },
  "mappings": { "_source": { "excludes": ["*_enc"] },                            // belt-and-suspenders: no PII in _source
    "properties": { "full_name": { "type": "text",
        "fields": { "suggest": { "type": "search_as_you_type" } } },
      "job_title": { "type": "text", "search_analyzer": "tp_search" },
      "canonical_title_id": { "type": "keyword" }, "seniority_level": { "type": "keyword" },
      "company_employee_band": { "type": "keyword" }, "company_technographics": { "type": "keyword" },
      "has_email": { "type": "boolean" }, "data_quality_score": { "type": "integer" },
      "region": { "type": "keyword" }, "jurisdiction": { "type": "keyword" } } } }
```

- **Why this beats Apollo's wound** (`RESEARCH_05 §A.1, §C.2`): the flattened company traits are **low-churn**
  firmographics, so the restamp fan-out fires rarely and runs bounded (§2.6); the **high-churn per-tenant fields
  that destroyed Apollo's index (owner/score) are architecturally absent** from the shared doc — they live only on
  the overlay (S3/S6). The denormalized `current_company_*` traits are recomputed from the *new* current edge in
  the same projection that closes the old `master_employment` edge (`PLAN_02 §2.2`; `PLAN_03 §1.3`), never
  hand-set — or the grid serves "person at the wrong company," the most expensive correctness bug.
- **Browse query plan:** filter person facets ∧ current-company facets in one query over the flattened doc (no
  join); page by **`search_after` + PIT** (§ keyset, `24 §6:258-266`); return **masked candidate `master_person_id`s**;
  Postgres authorizes the open/reveal (§RLS). Pagination is **never `from`/offset** (O(offset) + skip/dupe,
  `RESEARCH_05 §B.3`; the shipped overlay adapter is already keyset, `searchRepository.ts:245-255,376-403`).

### 2.3 The overlay browse surface — Postgres projection today → Typesense at scale (OQ2)

The overlay surface (Layer 1, "my prospects") is **RLS-bound** and ≤ 100M rows/workspace — Postgres is a complete
answer at MVP and is **already built**: `searchRepository` runs faceted, owner-scoped, keyset-paged search inside
`withTenantTx` so RLS is the hard wall (`searchRepository.ts:257-261`). Phase 2 swaps its **degenerate single
`accounts` left-join** (`account_id`, `searchRepository.ts:303,320,386`) for the master-backed overlay columns,
but the engine shape is unchanged.

**Cutover threshold (OQ2 resolved):** the overlay stays on Postgres until a workspace's overlay browse breaches
the **list/grid p95 150 ms SLO** (`ADR-0024:22`) — a documented trigger of **~5M overlay contacts/workspace** or
sustained p95 regression — at which point that workspace's overlay is mirrored to a **Typesense
collection-per-workspace** (natural blast-radius isolation: one tenant's import burst rebuilds only its own
collection, `24 §5.2:237`), fed by the same `search_outbox` (`entity_type='overlay_contact'`, `workspace_id` set).
**Typesense is the scale-out option, not a day-one requirement** — the brainstorm's B-as-overlay-substrate
(`BRAINSTORM_05 §4` part 4). Either way the overlay browse renders from **non-PII `contacts` facets**
(`email_domain`, `email_status` badge, `is_revealed`); the PII value hydrates from `revealed_channels` only on
detail/expand (`PLAN_04 §0.3`) — the overlay browse path **never** joins the channel store or touches PII.

### 2.4 ClickHouse facet store + exact-count MVs (OQ4)

OpenSearch terms aggs are **shard-local-top-N approximate** (`doc_count_error_upper_bound`,
`RESEARCH_05 §B.2`) — fine for the *exploration filter rail* (the user is browsing), **wrong** for a
**load-bearing count** where N becomes a credit spend. So the **"Select all N" total that seeds a bulk
reveal/export is exact from ClickHouse** (S7; DECISION part 5; `ADR-0035:85`), extending the shipped
exact-`countContacts` / capped-`resolveVisibleIds` split (`searchRepository.ts:287-325`) to billions.

```sql
-- A masked mirror of the golden doc, LowCardinality facet columns, fed from the SAME search_outbox stream.
-- ReplacingMergeTree on doc_version = same LWW guard as the OpenSearch external version (one truth, §2.1).
CREATE TABLE person_facets (
  master_person_id     UUID,
  doc_version          UInt64,
  canonical_title_id   LowCardinality(String),
  seniority_level      LowCardinality(String),
  department           LowCardinality(String),
  location_country     LowCardinality(String),
  company_industry     LowCardinality(String),
  company_employee_band LowCardinality(String),
  company_hq_country   LowCardinality(String),
  has_email            UInt8, has_phone UInt8,
  region               LowCardinality(String), jurisdiction LowCardinality(String),
  is_suppressed        UInt8                                 -- excluded at query; suppressed rows never counted (§RLS)
) ENGINE = ReplacingMergeTree(doc_version) ORDER BY (master_person_id);

-- Exact select-all-N: the deduped, non-suppressed population matching the SAME predicates the OpenSearch browse
-- filtered, as-of doc_version. FINAL (or argMax view) dedups the version; counts are the credit-spend truth.
-- Per-facet AggregatingMergeTree MVs (one per high-card facet) serve the filter-rail counts without re-scan.
```

**The exact-count contract (OQ4 resolved):** OpenSearch (browse/relevance) and ClickHouse (counts) are **two
engines, one truth** because both drain the **same `search_outbox` at the same `doc_version`**. The select-all-N
total is a single deduped `count()` over `person_facets` for the active predicates, returned **with its `doc_version`
watermark** so the UI shows an honest as-of total; the actual bulk reveal still resolves IDs **capped at
`BULK_SELECTION_CAP`** (`searchRepository.ts:308-325`) and re-checks credit + suppression **in-tx per take**
(§RLS) — the exact count sizes the spend; the cap bounds the mutation footprint; neither is cached for the take.

### 2.5 Redis facet/suggest cache — keys, TTLs, stampede, invalidation (OQ5)

Cache-aside with TTL as the safety net + version-stamp invalidation + stampede defense (`RESEARCH_05 §B.4`;
`ADR-0024:29`). **Deterministic key grammar** (canonicalize the query first so logically-equal queries share a
key — sorted filters, normalized text, explicit facet list):

```
  g:facet:{canonicalTitleHash}:{facetField}              -- GLOBAL facet count (system-owned; SHARED across tenants → high hit ratio)
  g:suggest:{facetField}:{prefix}                         -- GLOBAL typeahead
  ws:{workspace_id}:v{wsver}:facet:{queryHash}:{facetField}  -- OVERLAY facet count (per-workspace, version-stamped)
  lock:{key}                                              -- single-flight token (SET key tok NX PX) — one recompute, others wait
```

| Cache type | TTL | Stampede defense | Invalidation |
|---|---|---|---|
| Global facet count | 30–60 s | single-flight `SET NX PX` + **TTL jitter** + probabilistic early expiry (XFetch) | TTL-only (browse-tolerant; eventual) |
| Global typeahead | 300 s | single-flight + jitter | TTL-only |
| Overlay facet count | 60 s | single-flight + jitter | **version-stamp:** an overlay write bumps `wsver:{workspace_id}` → old keys orphan (no scan-and-delete) |
| Select-all-N **for the take** | — | — | **NEVER cached** (credit spend, C4) |
| Credit balance / suppression / permission | — | — | **NEVER cached** (`ADR-0024:29`; in-tx `FOR UPDATE` / `assertNotSuppressed`) |

- **Hot keys** (a popular query's facet rail hit by ≥ 5,000 concurrent users/workspace, `ADR-0024:27`) get the
  three-layer defense — single-flight so only one request recomputes, jitter so keys don't expire in lockstep,
  XFetch so a hot key refreshes *before* expiry (`redis.io thundering herd`, `RESEARCH_05 §B.4`).
- **Version-stamp invalidation** (overlay): a write bumps a per-workspace integer `wsver`; because `wsver` is in
  the key, stale keys are simply never read again and age out — no `KEYS`/scan, no per-key delete fan-out.
- **Per-tenant quota:** overlay keys are namespaced `ws:{workspace_id}:` so a hot workspace cannot evict another's
  cache beyond its slice (`ADR-0024:27`). The **global** facet cache is intentionally *shared* across tenants
  (the masked universe is system-owned, identical for everyone) — that is what makes its hit ratio high.

### 2.6 The search-sync worker + the hot-company restamp bound (OQ3)

A BullMQ worker (`apps/workers`) drains `search_outbox` in `seq` order from its `search_sync_state` cursor, fans
each entity to OpenSearch + ClickHouse (+ Typesense for `overlay_contact`), and advances the cursor. Idempotent
by `(doc id, doc_version)` external versioning (§2.1) — a redelivery or out-of-order drain is a no-op.

```
  search_outbox (seq order)
    ├─ entity_type='person'   → re-flatten master_persons OV + current-company traits → _bulk upsert (OS) + insert (CH)
    ├─ entity_type='company'  → re-flatten master_companies firmographics onto its OWN company facets (rare browse use)
    ├─ entity_type='company_employees'  ── THE HOT-COMPANY FAN-OUT (bounded) ──┐
    │     expand via idx_master_persons_company (03:426) ∧ idx_employment_current (03:436):
    │     SELECT id FROM master_persons WHERE current_company_id=:cid   -- only CURRENT employees
    │     → coalesced _bulk re-index in batches of B (e.g. 1,000), refresh_interval relaxed, rate-limited,
    │       backpressure-tripped → "indexing N rows…" indicator (24 §5.1:221-228); never one giant sync UPDATE
    └─ entity_type='overlay_contact' (ws set)  → Typesense collection-per-workspace upsert (§2.3)
```

**The restamp bound (OQ3 resolved):** a firmographic change on a company with millions of current employees is
**one** `company_employees` outbox row (O(1) enqueue), expanded by the worker into a **coalesced, batched,
rate-limited `_bulk` re-index of only the company's *current* employees** — bounded because (i) firmographics are
**low-churn** so it fires rarely, (ii) the fan-out is the *same* bounded set Apollo restamped but **without the
per-tenant owner/score field that made Apollo's storm continuous** (it isn't in the doc), and (iii) it runs async
off the OLTP primary with `refresh_interval` relaxed during the burst (`RESEARCH_05 §C.2`; `BRAINSTORM_05 §2 S3`).

**Job-change ordering (the "person at the wrong company" hazard, OQ3):** it is **one** outbox event, not two. The
survivorship re-projection (`PLAN_03 §1.3`) closes the old `master_employment` edge, opens the new, recomputes
`current_company_id` + the flattened company traits, **and then** enqueues a single `search_outbox(person, ...)`
in the same tx — so the worker always reads a **coherent, post-projection** snapshot and the doc can never reflect
the old company with the new title. Ordering across events is guarded by `doc_version` (LWW).

**Reconcile + divergence detection (OQ7 resolved):** three cadences make the C1 "rebuildable from truth"
guarantee operable: (1) a **continuous lag monitor** — `now() - search_outbox(min undrained).enqueued_at` against
the < 5 s CDC SLO (`ADR-0024:25`); (2) a **count-drift sample** (hourly) per Citus shard — Postgres
`count(master_persons WHERE NOT is_suppressed)` vs the index/CH doc count; (3) a **checksum sample** (daily) — a
rolling hash of a sampled key range vs the index. Divergence re-enqueues the affected `entity_id`s; a corrupt or
schema-changed index is rebuilt **blue/green behind the `master_persons` alias** by re-driving `search_outbox`
from a watermark (or re-scanning `master_*` by shard) — no customer-visible cutover.

### 2.7 `SearchPort` adapter seams (OQ8)

The composite hides behind the **existing `SearchPort`** (`search.ts:192-197`) so a bad adapter swaps with no
caller change (`ADR-0035:83`). Today only the **in-memory dev adapter** ships (`packages/search/src/index.ts:1-6`)
+ the Postgres `searchRepository` the api provider delegates to. Phase 5 adds a **`CompositeSearchPort`** that
dispatches by surface, plus the OpenSearch / ClickHouse / Typesense adapters:

- **`SearchCtx` gains `surface: 'global' | 'workspace'`** (the overlay already keys on `workspaceId`,
  `search.ts:170-175`; `SuggestQuery.scope` already exists, `search.ts:62`). `surface='global'` → OpenSearch +
  ClickHouse (masked, access-path, no `workspaceId` predicate); `surface='workspace'` → `searchRepository`/
  Typesense inside `withTenantTx` (RLS).
- **`facetCounts()` routes by surface and exactness** (OQ8 resolved): one method, not split — overlay → Postgres
  GROUP-BY (`searchRepository.ts:329-353`) / Typesense; global *browse* counts → OpenSearch terms aggs (approx);
  global *load-bearing* counts → ClickHouse exact. The exactness need is carried by the call site (the select-all
  flow asks for the exact total), keeping the port surface small.
- **Add `count(query, ctx)` to `SearchPort`** — today the exact total lives in `searchRepository.countContacts`
  (`searchRepository.ts:287-306`) but is **not** on the port; Phase 5 surfaces it so the global select-all-N
  routes to ClickHouse and the overlay to Postgres through the same seam. `index(entity,id,ctx)`
  (`search.ts:196`) is retained for the dev adapter + targeted/admin reindex; the steady-state write path is the
  `search_outbox`-driven worker, not per-call `index()`.

### ER / dataflow sketch

```
  POSTGRES TRUTH (C1)                                            DERIVED READ SURFACES (Tier 3, rebuildable)
  master_persons/companies/employment ──┐                       ┌─▶ OpenSearch master_persons_v1  (global browse, masked)
   field_provenance (NEVER read here) ──┘ survivorship reproj   │     search_after + PIT · suggesters · synonym_graph
        │ (PLAN_03 §1.3, same tx) ───▶ search_outbox(seq,ver,op)─┼─▶ ClickHouse person_facets     (exact counts, select-all-N)
        │                                   │ drained by         │     LowCardinality MVs · ReplacingMergeTree(doc_version)
        │                          search-sync worker (apps/workers, idempotent by id+version, §2.6)
        │                                   │                    └─▶ Typesense ws-collection       (overlay browse at scale, §2.3)
        ▼ TIER 1/2 STRONG (A — never indexed)                          Redis: facet/suggest cache (TTL+jitter+single-flight, §2.5)
  contacts ⋈ revealed_channels (detail/RYOW, RLS-local)         browse ─▶ masked candidate master_person_id ─▶ Postgres authorizes
  reveal: credit FOR UPDATE + suppression + decrypt (in-tx, uncached, PLAN_04 §0.4)        (open/reveal re-checked against truth)
```

---

## RLS policy implications

Two isolation regimes the read path must keep separate (C7/C8; the inverse postures `PLAN_04 §RLS` froze).

1. **Global masked search (Layer 0) — isolated by ACCESS PATH, not an RLS predicate.** The
   `master_persons_v1` doc carries **no `workspace_id` and no `owner`** (§2.2), so there is **no per-tenant ACL on
   the shared index to maintain or go stale** — isolation *is* the masked schema (`RESEARCH_04 §4.1`;
   `BRAINSTORM_05 §2 S6`). The index is masked **by construction**: it holds `has_email`/`has_phone` booleans,
   never `email_enc`/`phone_enc` — **the index NEVER holds an encrypted channel** (C3/C4; `03:383-384`). The only
   read-side gates on the global surface are **suppression** (`is_suppressed` rows excluded + `op='delete'` on flip,
   §2.1; `03:421`) and **region/jurisdiction residency** (`03:422`). The hard wall is the **reveal tx**, where
   credit + suppression + ownership are re-validated in-tx (`PLAN_04 §0.4`).
2. **Overlay browse (Layer 1) — FORCE-RLS, fail-closed.** Every overlay read runs inside `withTenantTx`
   (`searchRepository.ts:257-261`; `client.ts:48-68`) so a query **can never cross workspaces**
   (`workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid` → zero rows when unset,
   `rls/contacts.sql:5`; `03:692`). A Typesense overlay collection is **per-workspace** (collection = the blast
   radius, `24 §5.2:237`); even if a future overlay adapter stores an owner/visibility ACL on the doc, it is a
   **pre-filter only** — the open is re-checked against Postgres truth.
3. **Permission re-check at read = the index returns candidates, Postgres authorizes** (DECISION part 6; C4;
   `RESEARCH_05 §B.5`). Global browse returns masked candidate `master_person_id`s; the overlay browse is
   RLS-bounded; **owner/team/visibility is re-applied app-layer at read** (not an RLS predicate; `03:696`;
   ADR-0022) — today approximated by `owner = coalesce(owner_user_id, revealed_by_user_id)`
   (`searchRepository.ts:41,206`). A Stage-1 over-broad candidate from the index is a bounded UX bug; only a
   Stage-2 (Postgres) miss is an incident (`PLAN_04 §RLS-1`; the Azure-DLS caution, `RESEARCH_05 §B.5`).
   **Security has final say:** an eventually-consistent index ACL is never the authority on who-may-open.
4. **`search_outbox` / `search_sync_state` are system-owned** — no `workspace_id`-as-RLS-key, **no
   `GRANT … TO leadwolf_app`**; they are written by the projector and drained only by the **search-sync
   least-privilege role** (the third Layer-0-reaching role beside the ER pipeline + `leadwolf_reveal`, `03:698`;
   `PLAN_04 §RLS-2`). A tenant tx has no privilege on them.
5. **DSAR / deletion cascade reaches the index.** A data subject is one `master_persons` identity by
   `master_emails.email_blind_index` (`03:442`). Erasure (`withPrivilegedTx`, `client.ts:30-35`) tombstones the
   golden identity and enqueues `search_outbox(person, op='delete')` → the worker **removes the doc from OpenSearch
   + ClickHouse + every Typesense overlay collection** so the erased subject is no longer findable; the overlay
   copies + `revealed_channels` are deleted by `master_person_id` and the global suppression row blocks re-import
   (`PLAN_04 §RLS-3.5`). The index holds **no PII**, so erasure need only delete the masked doc — it never has to
   scrub a channel value out of the index (C3).

---

## Scale-gate analysis

Scale target: millions of users, **billions** of golden rows; ≥ 5,000 concurrent users/large workspace
(`ADR-0024:9,27`). N+1 and unbounded fan-out are failures (CLAUDE.md). *What breaks first at 10×, and the fix:*

| Rank | What breaks first at 10× | Why | Fix (this PLAN) |
|---|---|---|---|
| **1** | **Hot facet-count key (thundering herd)** | a popular query's facet rail is one key hit by thousands of concurrent users; expiry → stampede onto ClickHouse/OpenSearch | **Single-flight `SET NX PX` + TTL jitter + XFetch** (§2.5); exact counts off ClickHouse MVs (no re-scan); shared global cache → high hit ratio (`RESEARCH_05 §B.4`). |
| **2** | **Firmographic restamp fan-out** | a firmographic change on a million-employee company re-indexes every current employee doc — Apollo's storm | **`company_employees` = O(1) outbox row → coalesced, batched, rate-limited `_bulk` re-index of CURRENT employees only**; firmographics are low-churn; the per-tenant owner/score that made Apollo's storm continuous is **absent from the doc** (§2.6, S3). |
| **3** | **Deep pagination** | `from/offset` is O(offset) + skip/dupe under concurrent writes | **`search_after` + PIT** everywhere (global) + the already-keyset overlay cursor (`searchRepository.ts:376-403`); bounded `limit ≤ 200` (`search.ts:157`); never offset. |
| **4** | **Query-time join over billions** | the 4-table `contacts ⋈ master_persons ⋈ employment ⋈ companies` + facet GROUP BY blows the 200 ms p95 | **Pre-joined flattened doc** → one lookup, no join (S1/S2); A (live join) is **rejected as the browse default**, retained only for detail/RYOW. |
| **5** | **Index lag under a bulk burst** | a 1M-row import floods `search_outbox`; CDC lag breaches < 5 s | Relax `refresh_interval` + coalesced `_bulk` during the burst; **"indexing N rows…" honesty indicator** (`24 §5.1:226-228`) instead of a silently-incomplete result; lag monitored vs SLO (§2.6). |
| **6** | **Reads hitting the primary writer** | browse/analytics on the OLTP primary | Reads land on **OpenSearch shards + ClickHouse + Redis + Aurora read replicas, never the primary** (`ADR-0024:33`); only Tier-1 reveal/credit is in-tx on the primary. |

**Verdict:** every first-breakage is a bounded mechanism applied now (single-flight+jitter, O(1) fan-out marker,
keyset, pre-join, honesty indicator, replica/index reads) — none requires the un-built Citus/Iceberg track to be
complete (it is the deferred scale path, `ADR-0021:130-132`). The read path adds **no new authoritative store and
no query-time join**; it adds derived, rebuildable projections fed by one O(1) outbox marker per change.

---

## Failure modes

| # | Failure | Cause | Mitigation |
|---|---|---|---|
| F1 | **Index lag serves a stale/incomplete browse** | CDC drain behind the write by > SLO | Tier-3 browse is *honestly* eventual (< 5 s, `ADR-0024:25`); RYOW + detail route to Postgres (§1.1); the **"indexing N rows…"** indicator never pretends completeness (`24 §5.1:226-228`). |
| F2 | **Dropped / out-of-order CDC event diverges the projection** | a `search_outbox` row lost or drained out of order | **External versioning by `doc_version`** = LWW idempotency (§2.1); **reconcile** (lag + count-drift + checksum, §2.6) catches a dropped row; the projection is **rebuildable from truth** (C1, OQ7). |
| F3 | **Cache stampede on a hot facet key** | thousands of concurrent users on one expiring key | Single-flight lock + TTL jitter + XFetch (§2.5); exact counts off ClickHouse MVs (no re-scan). |
| F4 | **Stale facet count mis-charges a bulk reveal** | an approximate OpenSearch agg used for select-all-N | **Load-bearing counts are exact from ClickHouse** (S7, §2.4); approximate aggs only on the *browse* filter rail; the take re-checks credit + suppression in-tx and caps the mutation footprint. |
| F5 | **"Person at the wrong company"** | the flattened company traits not recomputed with the edge change | The projector closes the old edge, recomputes `current_company_id` + traits, **then** enqueues **one** `search_outbox(person)` in the same tx (§2.6, OQ3); `current_company_id` is a derived cache, never hand-set (`PLAN_02 §2.2`). |
| F6 | **Restamp storm on a hot company** | a firmographic change fans to every employee | O(1) `company_employees` marker → coalesced, batched, rate-limited `_bulk` of current employees only; owner/score not in the doc (§2.6, F2-of-Apollo). |
| F7 | **PII leaks into the index** | a channel value flattened onto the doc | **The index never holds `*_enc`** — `_source` excludes `*_enc` + only `has_email`/`has_phone` booleans are indexed (§2.2, C3/C4); PII hydrates only from `revealed_channels` on detail (`PLAN_04 §0.3`). |
| F8 | **Suppressed/erased identity remains findable** | the doc not removed on suppression/DSAR | `is_suppressed` flip / DSAR tombstone → `op='delete'` → doc removed from OpenSearch + ClickHouse + Typesense; suppressed rows excluded from `person_facets` counts (§2.1, §RLS-5; `RESEARCH_04 §3.4`). |
| F9 | **Index ACL treated as the authorization boundary** | trusting the masked pre-filter to authorize an open | The index returns **candidates**; Postgres (RLS + ownership + credit + suppression, in-tx) authorizes (§RLS-3; security has final say). |
| F10 | **A money/permission read served from cache** | caching the credit balance / suppression gate "for speed" | **Forbidden** (`ADR-0024:29`); credit `FOR UPDATE`, `assertNotSuppressed` read in-tx every time (`02 §3.1:104-111`); never cached, never indexed. |
| F11 | **A second, divergent source of truth** | the index becomes authoritative | The index/CH/Typesense are **CDC-derived, rebuildable from Postgres** (C1); reconcile + blue/green rebuild keep them derived (§2.6); never two authorities. |
| F12 | **Overlay facet cache leaks across workspaces** | a key shared between tenants | Overlay keys are namespaced `ws:{workspace_id}:v{wsver}:` (§2.5); global cache is shared *only* for the system-owned masked universe (no per-tenant data in it). |

---

## Pre-build thinking pass (the applicable items — `truepoint-architecture`; `PLAN_00 §8`)

- **1 Source of truth.** Postgres golden + overlay is truth; OpenSearch/ClickHouse/Typesense are **derived
  projections** (< 5 s CDC); Redis caches facet/suggest reads only. Never two authorities (C1; `24 §5:192-193`).
- **2 Failure modes / idempotency.** Drain is **idempotent by `(doc id, doc_version)`** external versioning;
  dropped event caught by reconcile; stale facet bounded by its TTL. Full list above.
- **3 Duplicate prevention (read side).** Keyset `search_after` + PIT → **stable paging, no skip/dupe** under
  concurrent writes (`RESEARCH_05 §B.3`); `doc_version` LWW prevents a stale re-index resurrecting an old doc.
- **4 Audit / change history.** Masked browse is a read (no mutation); **search-then-reveal** is the audited money
  path, attributable via `SearchCtx.userId` (`search.ts:170-175`); the reveal writes its audit in-tx (`PLAN_04 §0.4`).
- **5 Security (IDOR / exposure / secrets).** Global doc carries no `workspace_id`/owner → nothing to leak
  cross-tenant; overlay reads RLS-bounded; **no PII / no `*_enc` in the index** (C3/C4); permission re-checked at
  the Postgres read; the index ACL is a pre-filter, not the authority; `search_outbox` system-owned, no
  `leadwolf_app` grant.
- **6 Scalability / 10×.** Pre-joined doc (no join); keyset (constant paging); exact counts off columnar; reads on
  index/replicas/cache, **never the primary writer** (`ADR-0024:33`); O(1) fan-out marker. Scale-gate table.
- **7 Observability.** Emit search-sync lag (drain depth/age vs < 5 s SLO), facet-cache hit ratio + single-flight
  contention, masked-search p95 vs the 200 ms SLO (`ADR-0024:22`), restamp batch counts + "indexing N rows"
  gauge, reconcile count-drift/checksum results, `op='delete'` (suppression/DSAR) counts; runbook hooks for index
  lag + cache stampede + reindex.
- **8 Rollback.** The whole read model is **derived** → rebuildable from Postgres by re-driving `search_outbox`;
  a bad adapter swaps behind `SearchPort` with no caller change (`search.ts:192-197`; `ADR-0035:83`); the global
  index reindexes **blue/green behind an alias** (§2.6); the overlay falls back to the shipped Postgres
  `searchRepository` if Typesense is disabled — all flag-gated.
- **9 Edge cases.** Empty result (zero hits, null cursor); company-less person (no `current_company_id` → company
  facets absent, `RESEARCH_02 §2.6`); suppressed identity (excluded / `op='delete'`); just-revealed contact
  (RYOW from Postgres, §1.1); concurrent refinement (stale facet within TTL, refreshes next refinement); bulk
  import burst (honesty indicator); max page (`limit ≤ 200`, `search.ts:157`).
- **10 Assumptions (load-bearing).** (a) firmographics are **low-churn** so the restamp fan-out is rare (S3); (b)
  the projector enqueues **one** post-projection `search_outbox` per change so the doc is always coherent
  (`PLAN_03 §1.3`); (c) the overlay is ≤ Postgres's envelope until the documented cutover (OQ2); (d) the CDC
  freshness SLO (< 5 s) bounds the RYOW window (10 s margin).
- **11 Misuse.** No PII path through the index (C3); masked browse is **view-capped + small-cell-suppressed**
  against membership inference (`RESEARCH_04 §2.1, §3.4`; owned with the search-privacy threshold, OQ below); a
  workspace cannot infer Layer-0 membership beyond masked facets (C7).
- **12 Load behaviour (10×).** Bottleneck order = the Scale-gate ranks (hot facet key → restamp fan-out → deep
  paging → query-time join → index lag → primary-writer reads), each with its named fix.
- **13 Worst case.** A megacorp firmographic change + a mass import burst + a viral query all at once: bounded —
  the restamp is an O(1) marker → batched async `_bulk`, the import shows the honesty indicator, the viral query's
  facet rail is single-flighted + jittered + ClickHouse-served, and reads never touch the OLTP primary.

---

## Open questions

The eight `BRAINSTORM_05 §4` questions — each **resolved** by this PLAN or handed forward with an owner — plus
the residual decisions this gate opens:

1. **OQ1 — global doc field list + mapping.** *Resolved:* the `master_persons_v1` field set + OpenSearch
   types/analyzers/suggesters + the index-time `canonical_title_id` (§2.2); facet-only vs full-text vs both is in
   the table; the doc is lean (no PII, no per-tenant state, no map). *Residual:* the exact synonym seed +
   completion-vs-edge-ngram choice per field (owned with `ADR-0035`).
2. **OQ2 — overlay substrate cutover threshold.** *Resolved:* Postgres `searchRepository` until the **150 ms
   list/grid p95 SLO** breaks (≈ 5M overlay contacts/ws), then Typesense collection-per-workspace fed by the same
   `search_outbox` (§2.3); Typesense is **not** day-one. *Residual:* the precise per-workspace trigger metric +
   the auto-provision/migrate runbook (owned with `truepoint-operations`).
3. **OQ3 — CDC propagation + hot-company restamp + job-change ordering.** *Resolved:* `company_employees` = an
   O(1) outbox marker expanded into a coalesced, batched, rate-limited `_bulk` re-index of current employees
   (§2.6); job change is **one** post-projection event, `doc_version`-ordered (no "wrong company"). *Residual:* the
   restamp batch size / `refresh_interval` relaxation / backpressure-trip constants (load-test, with Phase 6).
4. **OQ4 — ClickHouse MV set + exact-count contract.** *Resolved:* `person_facets` (ReplacingMergeTree on
   `doc_version`) + per-facet AggregatingMergeTree MVs; the select-all-N exact total is a deduped `count()` as-of
   `doc_version`, coherent with the OpenSearch result set because both drain the same outbox (§2.4). *Residual:*
   the facet MV list is finalized with the §2.2 facet set; the small-cell-suppression threshold (OQ below).
5. **OQ5 — Redis key/TTL/stampede policy.** *Resolved:* the key grammar, per-type TTLs, single-flight+jitter+XFetch,
   version-stamp overlay invalidation, per-tenant namespace quota (§2.5). *Residual:* the exact TTL values +
   jitter/XFetch β re-tuned from measured hit ratio (with `truepoint-operations`).
6. **OQ6 — RYOW routing mechanism.** *Resolved:* detail is always Postgres; overlay browse falls back to Postgres
   within a 10 s `ryow:{ws}:{user}` window; global browse is always eventual + honesty indicator; the SSE live
   cell covers the revealed value (§1.1). *Residual:* whether the window is per-user or per-session, and the SSE
   vs poll fallback (with `truepoint-design` for the indicator UX).
7. **OQ7 — reconcile + divergence detection.** *Resolved:* lag monitor (continuous) + count-drift sample
   (hourly/shard) + checksum sample (daily) + blue/green rebuild from a watermark (§2.6). *Residual:* the sample
   rate + the divergence alarm thresholds that gate an auto-rebuild (with `truepoint-operations`).
8. **OQ8 — `SearchPort` adapter seams.** *Resolved:* a `CompositeSearchPort` dispatching by `SearchCtx.surface`;
   `facetCounts()` one method routing by surface+exactness; **add `count()` to the port**; `index()` retained for
   dev/targeted reindex, steady-state via the worker (§2.7). *Residual:* the exact `SearchCtx.surface` default for
   existing callers (must default `'workspace'` so shipped overlay callers are unchanged).

**Newly opened by this PLAN:**

- **NQ1 — masked-search privacy thresholds.** The small-cell-suppression minimum-bucket size + the per-user/
  per-workspace browse view-cap + rate limits that bound facet/aggregate membership inference
  (`RESEARCH_04 §2.1, §3.4`; `PLAN_04` scale-gate #4) — owned jointly with `truepoint-security` + the `ADR-0035`
  search design. Load-bearing: a masked count can leak the *existence* of a record the user cannot reveal.
- **NQ2 — outbox vs Debezium for the steady-state feed.** This PLAN chooses the transactional `search_outbox`
  (entity-level, post-projection, coherent); whether the high-throughput master-graph track later swaps to
  Debezium logical replication (`02 §3.3:164`) behind the same worker is a scale decision — **deferred**, default
  outbox.
- **NQ3 — global facet engine for *browse* counts.** Browse-rail counts can come from OpenSearch terms aggs
  (approximate, cheap) *or* ClickHouse (exact, costlier); the PLAN allows either (§2.4) — the per-facet choice is
  a cost/accuracy tune deferred to load-test.

> **Implementation status (gap → work-to-do, never license to skip a rule).** Today **only the Layer-1
> overlay-Postgres read path is built**: `searchRepository` does workspace-RLS-scoped ILIKE search + keyset paging
> + GROUP-BY facet counts + ILIKE typeahead inside `withTenantTx` (`searchRepository.ts:257-403`), and the only
> shipped `SearchPort` adapter is the **in-memory dev adapter** (`packages/search/src/index.ts:1-6`); the overlay
> join still uses the **degenerate single `account_id` FK** (`searchRepository.ts:303,320,386`), the link Phase 2
> replaces. The **global OpenSearch `master_persons_v1` doc, the ClickHouse `person_facets` + exact-count MVs, the
> Typesense overlay collections, the Redis facet/suggest cache, the `search_outbox`-driven search-sync worker, and
> the RYOW/reconcile machinery are all unbuilt** — designed in `ADR-0021:72-77`, `ADR-0035`, `03 §12:744-753`,
> `02 §3.3`, but with no code (`RESEARCH_00 §7.1 P8`). They also depend on the upstream Phase-1→4 co-land (the
> `master_*` tables, the `current_company_id` derived cache, the materialized scalar OV + `search_outbox` emit,
> and `revealed_channels`), themselves target-not-built. None of these gaps relaxes a constraint: when built, the
> global doc stays **masked + PII-free + `*_enc`-free + `workspace_id`-free** (isolated by access path, C3/C7), the
> overlay read stays **FORCE-RLS + owner-scoped** (C8/C10), the credit/suppression checks stay **in-tx and
> uncached** (C4), exact load-bearing counts stay **exact** (S7), and the index stays a **derived projection of
> Postgres truth, rebuildable, never a second authority** (C1). The deferrals (Typesense cutover, Debezium swap,
> per-facet count engine, privacy thresholds) are **deferral, not omission** — each is reachable additively from
> the substrate this gate freezes. Security has final say (CLAUDE.md precedence).
