# RESEARCH 05 — Read Path, Search & Caching for the Linked Prospect+Company View

> **Gate:** RESEARCH · **Phase:** 5 — Read Path, Search & Caching · **Depends on:** the shared ground-truth
> brief for this initiative, [RESEARCH_00](./RESEARCH_00_current_state.md) (the BUILT/PLANNED/UNDESIGNED audit —
> esp. the degenerate `account_id` link and the unbuilt scale topology P8), [RESEARCH_01](./RESEARCH_01_entity_modeling.md)
> (canonical entity model: `current_company_id` is a *derived cache* of the current edge), [RESEARCH_02](./RESEARCH_02_linking_patterns.md)
> (the edge; "person at company with these traits" as a first-class query; denormalized backfill must be recomputed),
> [RESEARCH_03](./RESEARCH_03_mdm_merge.md) (the JSONB `field_provenance` map materialized on write, never derived at
> read on the hot path). **Ground truth:** [ADR-0021](../decisions/ADR-0021-global-master-graph-and-overlay.md) (two-layer
> model + search topology), [ADR-0035](../decisions/ADR-0035-search-query-and-filter-architecture.md) (query semantics,
> suggesters, facet counts), [ADR-0024](../decisions/ADR-0024-performance-slos-and-capacity-model.md) (SLOs + cache policy),
> [03 §5.1/§9/§12](../03-database-design.md), [02 §3.3](../02-architecture.md), [24 §5–§7](../24-advanced-search-exploration-ux.md),
> and the shipped `SearchPort` contract (`packages/types/src/search.ts`) + the Postgres overlay read path
> (`packages/db/src/repositories/searchRepository.ts`). **Feeds:** the Phase-5 BRAINSTORM and PLAN gates. This doc
> **researches and documents only** — it proposes no schema, finalizes no DDL, and writes no code.

---

## 0. Scope, method, and epistemics

This document answers one question: **how does TruePoint serve the flattened prospect+company view — "person at a
company with these company traits" — fast, fresh, isolated, and cheap, across the two-layer split, at billions of
rows?** It studies the read-side patterns (denormalized read model / projection / materialized view, search-index-as-
read-model, firmographic faceting, cursor pagination, Redis caching with event-driven invalidation, read-your-own-write,
and permission re-check at read), how the leading B2B-data platforms actually implement them, then maps each onto
TruePoint's constraints and recommends a read-path design.

This is the **read** counterpart to the earlier write-side gates: RESEARCH_01–03 designed *what the golden record is*
and *how it merges*; this gate designs *how a customer reads it back*. The earlier gates established two facts this one
builds on directly: (a) `master_persons.current_company_id` is a **derived cache** of the current employment edge, not
authoritative (RESEARCH_01 §2 / RESEARCH_02 §2.5) — the read model is therefore *already* a denormalization the system
must keep coherent; and (b) the golden value + `field_provenance` map is **materialized on write**, so the read path
never recomputes survivorship per attribute (RESEARCH_03 §C.3). The read path inherits both.

**Epistemic legend.** Search-platform internals are partly proprietary; this doc separates what a vendor *states* from
what is *reasoned*:

- **[VERIFIED]** — stated by the vendor / an authoritative engineering source, with a cited URL.
- **[INFERRED]** — reasoned from public behaviour or general practice; **not** asserted as fact.

Internal claims cite `file:line` (code/schema) or ADR/doc section.

**The constraints every read-path candidate must survive** (from the brief + RESEARCH_00–03):
(1) **two read surfaces, not one** — the **global masked search** over system-owned Layer 0 (find-anyone), and the
**per-workspace overlay browse** over RLS-scoped Layer 1 (my prospects); they have *different* isolation models and must
not be conflated; (2) **Postgres is truth, the index is a derived query surface** — never two independent sources of
truth ([ADR-0002](../decisions/ADR-0002-search-postgres-then-engine.md) amended; [24 §5](../24-advanced-search-exploration-ux.md));
(3) **billions of rows × thousands of concurrent users/workspace** under hard latency SLOs (masked search p95 200 ms,
[ADR-0024:22](../decisions/ADR-0024-performance-slos-and-capacity-model.md)); (4) **PII never leaves the index** — search
returns masked rows; a `master_emails`/`master_phones` channel unmasks only inside the reveal transaction
([03 §9:698](../03-database-design.md), [02 §3.3:170-171](../02-architecture.md)); (5) **permissions are re-checked
against truth at read** — the index returns *candidates*; what a user may open is governed by tenant scope + ownership/
sharing at the Postgres read (brief SEARCH+CACHE note; [ADR-0035:50-51](../decisions/ADR-0035-search-query-and-filter-architecture.md)).

---

## Part A — How the leading platforms serve the read path at scale

### A.1 Apollo.io — the denormalize-then-join cautionary tale (the single most relevant case study)

This is the most directly transferable external evidence in the whole initiative and is worth detailing, because Apollo
hit **exactly** the "person at company with these company traits" read problem at our scale and publicly documented both
the failure mode and the fix.

- **[VERIFIED]** Apollo runs **~210M B2B contacts** with two core models — **contacts** and **accounts** — and originally
  **replicated (denormalized) account fields onto contact records to enable faster querying.** This is the textbook
  flattened read model. Source:
  [siren.io — Apollo case study](https://siren.io/case-study-transforming-enterprise-search-at-apollo-with-siren-federate/),
  [businesswire](https://www.businesswire.com/news/home/20250128640056/en/Apollo.io-Elevates-Enterprise-Search-with-Siren).
- **[VERIFIED]** The denormalization **broke at fan-out.** For accounts with **~150,000 associated contacts**, a change
  to a **frequently-changing account field (e.g. `account owner`)** required re-stamping that value onto every child
  contact: *"The platform couldn't efficiently queue millions of Elasticsearch reindex operations, leading to incorrect
  results, missing data and underestimated Total Addressable Market (TAM) calculations"* — ~30 support tickets/month.
  Source: [siren.io case study](https://siren.io/case-study-transforming-enterprise-search-at-apollo-with-siren-federate/).
- **[VERIFIED]** The fix was **Siren Federate** — an Elasticsearch plugin that performs **data joins at query time**
  across a **350-node** cluster — *instead of* denormalizing the volatile field. Result: **average search 5–7 s → 1.2 s**,
  **~50% more results (~400k more contacts/search)**, tickets **30/mo → 0**, rollout **50 largest customers → 100% of
  traffic**. Sources:
  [siren.io case study](https://siren.io/case-study-transforming-enterprise-search-at-apollo-with-siren-federate/),
  [siren.io — Apollo](https://siren.io/apollo-io-elevates-enterprise-search-with-siren/),
  [venturebeat](https://venturebeat.com/business/apollo-io-elevates-enterprise-search-with-siren).
- **The load-bearing lesson for TruePoint.** Flattening person+company into one search doc is the **right default for
  read speed** (no query-time join over billions). But **what you flatten matters**: denormalizing a *stable, low-churn*
  firmographic (industry, employee_band, primary_domain, technographics) is cheap and safe; denormalizing a
  *high-churn, high-fan-out* field (an owner/assignment, a score, a reveal flag) onto every person doc is a **reindex
  storm** waiting to happen. Apollo proves the failure mode at exactly our fan-out. The TruePoint mitigation is structural
  (see §C.2): **the volatile, high-fan-out state is workspace overlay state, which is NOT in the global golden doc at all**
  — it is joined/filtered in the overlay read path, not stamped onto a billions-row shared index.

### A.2 ZoomInfo — Solr JSON Facet API; firmographic + role faceting as the read surface

- **[VERIFIED]** ZoomInfo's search is **Apache Solr**, and it migrated from legacy faceting to the **JSON Facet API**
  (ahead of a Solr 9 move) for cleaner nested/multi-select facets. Its user-facing facets include **Location, Management
  Levels, and Job Departments**, combinable for targeted searches. Source:
  [engineering.zoominfo.com — JSON Faceting](https://engineering.zoominfo.com/enhancing-search-migrating-from-traditional-solr-faceting-to-the-json-faceting-api).
- **[VERIFIED]** Solr's JSON Facet API supports **multi-select faceting** (a facet that excludes its *own* filter so its
  options keep showing independent counts) via tag/exclude domains. Sources:
  [solr.apache.org — JSON Facet API](https://solr.apache.org/guide/solr/latest/query-guide/json-facet-api.html),
  [sease.io — facets & ACL filters via tag/exclusion](https://sease.io/2018/12/apache-solr-facets-and-acl-filters-using-tag-and-exclusion.html).
- **Lesson for TruePoint:** the **multi-select / exclude-own-filter facet behaviour** ZoomInfo gets from Solr's
  tag/exclude is **already the contract** of the shipped overlay adapter — `facetCounts(query, field)` drops the facet's
  own term filter (`buildWhere(query, exceptFacet)`, `searchRepository.ts:180-188,329-353`) so each facet's options stay
  independently countable ("Apollo behaviour", `searchRepository.ts:56,327-328`). The pattern is the same; the open
  question is the **engine** that serves it at billions (§B.2), not the semantics.

### A.3 Search-index-as-read-model — the CQRS / materialized-view consensus

- **[VERIFIED]** A search index is a **legitimate CQRS read model**: the read side maintains **incremental
  materialized views / denormalized projections** that update continuously as write-side events arrive — *"search
  indexes, graph projections, cache grids, OLAP cubes … are legitimate read models."* The two sides are **eventually
  consistent** — a small delay between a write and its appearance in the read store. Sources:
  [learn.microsoft.com — CQRS pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs),
  [nilus.be — read models as cache topology](https://www.nilus.be/blog/read_models_as_cache_topology_in_cqrs_architecture/).
- **[VERIFIED]** The **read-your-own-write** gap is solved by **routing the writer's own immediate read to the write
  store** for a short window (or a "pending state" UI), *not* by waiting for the projection to converge. Sources:
  [learn.microsoft.com — CQRS](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs),
  [tacnode.io — CQRS eventual consistency](https://tacnode.io/post/cqrs-pattern).
- **Lesson for TruePoint:** this **is** TruePoint's already-chosen posture — *"Postgres is the system of record; search
  runs on a denormalized index kept in sync by CDC"* ([24 §5:192-193](../24-advanced-search-exploration-ux.md)), Aurora
  logical replication → **search-sync** worker → OpenSearch/Typesense/ClickHouse ([02 §3.3:162-171](../02-architecture.md)),
  with a **< 5 s CDC freshness SLO** ([ADR-0024:25](../decisions/ADR-0024-performance-slos-and-capacity-model.md)). The
  RYOW answer is the corpus rule **"detail read + read-your-own-write come from Postgres"** (brief SEARCH+CACHE) — the
  read of *your* just-revealed contact hits Postgres (the reveal tx committed there, [02 §3.1:103-114](../02-architecture.md)),
  not the eventually-consistent index. The research **affirms** the architecture; this gate's job is to specify *which read
  lands where* (§C.1).

### A.4 Cross-platform synthesis

| Dimension | Apollo | ZoomInfo | TruePoint target |
|---|---|---|---|
| Read model | denormalized contact+account → **broke at fan-out** → query-time join (Siren) | Solr denormalized docs + JSON facets | **flatten stable firmographics**, keep volatile overlay state out of the global doc (§C.2) |
| Engine | Elasticsearch + Siren Federate (350 nodes) | Apache Solr (Lucene family) | **OpenSearch** (global) + **Typesense** (overlay) + **ClickHouse** (counts) ([ADR-0021:72-77](../decisions/ADR-0021-global-master-graph-and-overlay.md)) |
| Facet counts | ES terms aggs | Solr JSON facets (multi-select) | **ClickHouse exact** (billions) + OpenSearch aggs (overlay), Redis-cached ([ADR-0035:46-48](../decisions/ADR-0035-search-query-and-filter-architecture.md)) |
| "Person at company w/ traits" | join contacts↔accounts at query time | facet on contact + company fields | **flattened golden doc** (person + current company traits in one doc, §C.2) |
| Consistency | reindex on change (the storm) | CDC-style sync | CDC < 5 s; RYOW from Postgres ([ADR-0024:25](../decisions/ADR-0024-performance-slos-and-capacity-model.md)) |

**The consensus:** flatten for read speed (no billions-row query-time join *as the default*), but **fan-out-stamping a
volatile field onto a high-cardinality child set is the canonical scaling failure** — Apollo's exact wound. Keep the
flattened doc's fields **stable**; serve high-churn, per-tenant state from a different, smaller surface.

---

## Part B — The read-path pattern toolkit

### B.1 Denormalized read model / projection — flatten person + company

The core read pattern is to **denormalize the person and their current company's firmographics into one search
document**, so the query *"person at a company with these company traits"* is answered by **one index lookup**, not a
join across `master_persons` ⨝ `master_employment` ⨝ `master_companies` at query time over billions of rows.

- **[VERIFIED]** In Elasticsearch/OpenSearch, **denormalization gives the best query performance** because no join
  happens at query time; each `join`/`has_child`/`has_parent`/`nested` query *"adds a significant tax."* Parent-child
  join only pays off when the child entity **massively outnumbers** the parent (offers≫products); practical relationship
  performance **falls off fast beyond 2–3 levels.** Sources:
  [rockset — SQL joins in Elasticsearch](https://rockset.com/blog/can-i-do-sql-style-joins-in-elasticsearch/),
  [elastic — join field type](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/parent-join),
  [medium — denormalize ES index mapping](https://medium.com/@jeremy.gachet/denormalization-for-elasticsearch-index-984ce7cfa50a).
- **The cost is duplication + restamp-on-change.** A flattened doc stores the company's traits on every employee doc; a
  company firmographic change must re-propagate to all its employee docs. **[VERIFIED]** This is precisely the Apollo
  fan-out storm (§A.1) — but note: firmographics (industry, employee_band, technographics) change **rarely**, while the
  field that broke Apollo (`account owner`) is **per-tenant assignment state**, not a firmographic. The mitigation is to
  flatten **only low-churn golden traits**, and the propagation is a **bounded CDC fan-out** (re-index the company's
  current employees) not an unbounded synchronous storm — bulk `_bulk` writes + coalesced CDC events
  ([24 §5.1:221-225](../24-advanced-search-exploration-ux.md)).
- **TruePoint already reserved the denormalization:** `master_persons.current_company_id` is the denormalized current
  edge ([03:413](../03-database-design.md)), and `has_email`/`has_phone` are **precomputed boolean facets so search needs
  no join at query time** ([03:418-419](../03-database-design.md)). RESEARCH_01/02 fixed the discipline: the
  denormalization is a **derived cache recomputed transactionally when the current edge changes**, never independently
  writable (RESEARCH_02 §2.5) — so it can never silently disagree with the edge the way Apollo's stale stamp did.

### B.2 The engine split — inverted index for retrieval, columnar for counts

The read path needs three distinct capabilities, and no single engine is best at all three at billions of rows:

| Capability | Best-fit engine | Why |
|---|---|---|
| **Masked retrieval + filter + typeahead + relevance** (global, billions) | **OpenSearch** (sharded inverted index) | Lucene-family is what Apollo (ES) + ZoomInfo (Solr) prove at this workload; `search_after` cursoring, completion/edge-ngram suggesters, `synonym_graph` ([ADR-0035:25-44](../decisions/ADR-0035-search-query-and-filter-architecture.md)) |
| **High-cardinality exact facet counts** (billions) | **ClickHouse** (columnar, `LowCardinality`, MVs) | see below |
| **Per-workspace overlay browse** (≤100M) | **Typesense** (collection-per-workspace) | natural blast-radius isolation; one tenant's import burst rebuilds only its own collection ([24 §5.2:237](../24-advanced-search-exploration-ux.md)) |

**Exact vs approximate counts — the correctness nuance.**

- **[VERIFIED]** Elasticsearch/OpenSearch **terms aggregations are approximate** when `size < cardinality`: each shard
  returns its local top-`shard_size` terms and the coordinator merges them, so a globally-11th term can be missed; the
  error is surfaced as `doc_count_error_upper_bound`, and exactness requires raising `shard_size` (memory/compute cost)
  or paginating every bucket with a `composite` aggregation. High-cardinality terms aggs are a common cause of circuit-
  breaker trips, and ES caps default buckets at 10,000. Sources:
  [opensearch.org — terms aggregation](https://docs.opensearch.org/latest/aggregations/bucket/terms/),
  [elastic — terms aggregation](https://www.elastic.co/docs/reference/aggregations/search-aggregations-bucket-terms-aggregation).
- **[VERIFIED]** ClickHouse aggregates billions of rows with a **vectorized SIMD engine** at *"5x or lower aggregation
  latency"* than ES's JVM pipeline; in a published billion-row matchup **ES could not even load 100B rows**, ClickHouse
  used **~10x less storage**, and **incremental materialized views** compute partial aggregation state on insert so an
  exact count never re-scans the raw table. Sources:
  [clickhouse.com — billion-row matchup](https://clickhouse.com/blog/clickhouse_vs_elasticsearch_the_billion_row_matchup),
  [clickhouse.com — mechanics of count aggregations](https://clickhouse.com/blog/clickhouse_vs_elasticsearch_mechanics_of_count_aggregations).
- **TruePoint's design already encodes this split** — ClickHouse `LowCardinality` facet columns + materialized views for
  **exact** counts at billions; OpenSearch terms aggs for the overlay, *"noting shard-local-top-N approximation"*
  ([ADR-0035:46-48](../decisions/ADR-0035-search-query-and-filter-architecture.md), [24 §5:198-202](../24-advanced-search-exploration-ux.md)).
  The research **confirms** the topology and sharpens *where exactness is load-bearing* (§C.3).

### B.3 Cursor pagination — `search_after` + PIT, never offset

- **[VERIFIED]** `from`/`offset` paging is **O(offset)**: every shard builds a sorted set of `from+size` docs and ships
  them to the coordinator, which discards all but the page — and it **skips/dupes rows when data shifts**. `search_after`
  (keyset) cost is **constant regardless of depth** because each request seeks past the last sort key; a **Point-in-Time
  (PIT)** snapshot gives consistent paging without pinning shard contexts the way `scroll` does. Cost: **no random page
  jump** — sequential only. Sources:
  [elastic — paginate search results](https://www.elastic.co/guide/en/elasticsearch/reference/current/paginate-search-results.html),
  [luigisbox — ES pagination guide](https://www.luigisbox.com/blog/elasticsearch-pagination/),
  [jcleow — search_after + PIT](https://jcleow.github.io/2023/12/01/Elasticsearch-understanding-deep-pagination-using-search-after-and-pit.html).
- **TruePoint already mandates this** — keyset/`search_after` + PIT, *"never deep `from/offset`"*, cursor =
  `{ sortKeys, pitId, pageSize }` opaque-base64 ([24 §6:258-266](../24-advanced-search-exploration-ux.md),
  [ADR-0035:50](../decisions/ADR-0035-search-query-and-filter-architecture.md)), and the **shipped overlay adapter is
  already keyset** — it seeks on `(priority_score, id)` or `(created_at, id)` with an opaque base64 cursor and **never
  uses offset** (`searchRepository.ts:245-255,376-403`; `contactQuery.cursor`, `types/src/search.ts:151-159`). The
  research point: the **PIT is the missing piece** the OpenSearch adapter must add that the Postgres adapter approximates
  with MVCC snapshot isolation inside `withTenantTx`.

### B.4 Redis caching — cache-aside + TTL + event-driven invalidation + stampede defense

- **[VERIFIED]** The standard read cache is **cache-aside with a TTL as a safety net** for missed invalidations, layered
  with **event-driven (Pub/Sub) invalidation** when source data changes — the TTL is *"shorter than your tolerance for
  stale data but long enough to provide meaningful hit rates."* Sources:
  [layrs.me — cache-aside](https://layrs.me/course/hld/11-cloud-design-patterns/cache-aside-pattern),
  [oneuptime — Redis cache invalidation](https://oneuptime.com/blog/post/2026-01-25-redis-cache-invalidation/view).
- **[VERIFIED]** Hot keys under concurrency cause a **cache stampede / thundering herd**; the 2026 consensus is to
  **layer** three defenses: **single-flight locking** (`SET key token NX PX ttl` — one request recomputes, others wait),
  **TTL jitter** (random variance so keys don't expire in lockstep), and **probabilistic early expiration (XFetch)**.
  Sources:
  [redis.io — taming the thundering herd](https://redis.io/blog/how-to-tame-the-thundering-herd-problem/),
  [oneuptime — Redis cache stampede](https://oneuptime.com/blog/post/2026-01-21-redis-cache-stampede/view).
- **TruePoint's cache policy is already typed** — *"typed cache tiers with explicit TTLs and **invalidate-on-write** for
  entity/entitlement/search-facet caches; **no unbounded staleness on money/permission paths**"*
  ([ADR-0024:29](../decisions/ADR-0024-performance-slos-and-capacity-model.md)), and facet counts are *"cached in Redis
  with a short, per-facet TTL"* ([ADR-0035:46-48](../decisions/ADR-0035-search-query-and-filter-architecture.md),
  [24 §5:204-206](../24-advanced-search-exploration-ux.md)). Redis is already in the stack (BullMQ queues, SSE pub/sub,
  [02 §3.4:173-177](../02-architecture.md)). The research adds the **stampede discipline** (single-flight + jitter on hot
  facet-count keys) and the hard rule: **the credit balance and the suppression/permission gate are never read from a
  TTL cache** — they are read in-tx with `FOR UPDATE` / `assertNotSuppressed` ([02 §3.1:104-111](../02-architecture.md)).

### B.5 Permission re-check at read — the index returns candidates, truth authorizes

- **[VERIFIED]** Document-level security in search engines (Azure AI Search, OpenSearch DLS) works by **storing ACL/
  principal metadata on the indexed doc and filtering at query time** (e.g. `search.in(principals)`), **but the identity
  system remains the source of truth** for access decisions, and the doc-level filter only holds *if the ACL metadata is
  synced to the index.* Sources:
  [learn.microsoft.com — document-level access control](https://learn.microsoft.com/en-us/azure/search/search-document-level-access-overview),
  [docs.opensearch.org — document-level security](https://docs.opensearch.org/latest/security/access-control/document-level-security/).
- **Lesson for TruePoint:** an index-side ACL filter is a **fast pre-filter**, never the authority — because the index is
  eventually consistent, a stale ACL could leak. The corpus rule is exactly this: *"search returns candidate IDs fast;
  what the user may open is governed by tenant scope + ownership/sharing **at read** [against Postgres truth]"* (brief
  SEARCH+CACHE; [ADR-0035:50-51](../decisions/ADR-0035-search-query-and-filter-architecture.md)). This bifurcates by
  layer: **global masked search** (Layer 0) returns masked, **PII-free** candidate IDs to *anyone* (the universe is
  searchable by access path), so there is no per-workspace ACL on the global doc to go stale; **overlay browse** (Layer 1)
  is bounded by **RLS** (the hard wall) at the Postgres read, with owner/team visibility re-applied app-layer
  ([03 §9:696,698](../03-database-design.md)). The reveal/ownership/credit check is **always** re-validated in the write
  tx, never trusted from the index.

### B.6 Read-your-own-write & eventual-consistency boundaries

Synthesising §A.3 + the brief: the read path has **three consistency tiers**, and each query must be assigned to one:

```
  TIER 1 — STRONG (Postgres, in-tx)            TIER 2 — RYOW (Postgres direct)        TIER 3 — EVENTUAL (index, < 5s)
  reveal credit decrement (FOR UPDATE)         record detail drawer (open a contact)  global masked search / filter
  suppression / DNC gate (assertNotSuppressed) the contact you JUST revealed/edited   facet counts (Redis-cached)
  ownership / first-reveal write               "my prospects" list immediately after  typeahead suggestions
  → money + permission: NEVER cached/indexed     a mutation                            → browse: stale-tolerant, honest
```

**[VERIFIED]** This is the CQRS RYOW pattern — route the writer's immediate read to the write store, show a pending-state
indicator otherwise ([learn.microsoft.com — CQRS](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs)).
TruePoint already has the honesty primitive: the *"indexing N new rows…"* backpressure indicator after a bulk import
([24 §5.1:226-228](../24-advanced-search-exploration-ux.md)) — the grid tells the truth instead of pretending the result
set is complete.

---

## Part C — Mapping onto TruePoint: the constraints filter

### C.1 The two read surfaces — where each query lands (the central design decision)

The two-layer model forces **two distinct read paths**, with different engines, isolation models, and consistency tiers.
Conflating them is the primary design error to avoid.

```
  ┌──────────────────────── GLOBAL MASKED SEARCH (find-anyone) ───────────────────────┐
  │  Surface: Prospector / "search the universe"        Layer 0 (system-owned, NO RLS) │
  │  Engine:  OpenSearch (sharded, billions) + ClickHouse facet counts                 │
  │  Doc:     FLATTENED golden person + current-company traits + masked channels       │
  │           (has_email/has_phone booleans; NO PII; NO workspace_id; NO owner)        │
  │  Isolation: ACCESS PATH — masked-only; reveal is the paid unmask gate              │
  │  Consistency: TIER 3 eventual (CDC < 5s); permission = "is this masked + suppressed"│
  └───────────────────────────────────────────────────────────────────────────────────┘
                                   │  reveal (paid, in-tx) copies channel → overlay
                                   ▼
  ┌──────────────────────── OVERLAY BROWSE (my prospects) ────────────────────────────┐
  │  Surface: Contacts grid / lists / "my prospects"    Layer 1 (RLS-scoped overlay)   │
  │  Engine:  Typesense (collection-per-workspace, ≤100M) OR Postgres (today)          │
  │  Doc/row: workspace's contacts + overlay state (owner, score, outreach, lists)     │
  │  Isolation: RLS (workspace_id, FORCE) is the hard wall + app-layer owner/team       │
  │  Consistency: TIER 2 RYOW from Postgres for detail + just-mutated rows              │
  └───────────────────────────────────────────────────────────────────────────────────┘
```

- The **global doc carries NO workspace_id and NO owner/assignment/score** — that is the structural fix for the Apollo
  fan-out storm (§A.1, §C.2): the field that broke Apollo (a per-tenant owner) **does not exist on the shared billions-row
  index at all.** Per-workspace state lives only in the overlay surface.
- **Today, only the overlay-Postgres path is built**: `searchRepository` runs ILIKE scans + keyset paging + GROUP-BY
  facet counts + ILIKE typeahead, all inside `withTenantTx` so **RLS is the boundary** (`searchRepository.ts:1-15,
  259-285,329-372`), and the only `SearchPort` adapter shipped is the **in-memory dev adapter** (`packages/search/src/index.ts:1-6`).
  The global OpenSearch path, the ClickHouse counts, the Typesense overlay collections, and the Redis cache are **all
  unbuilt** (RESEARCH_00 §7.1 P8) — this is the Phase-5 build surface, not a re-architecture.

### C.2 The "person at a company with these company traits" query — flatten, but flatten the right thing

This is the initiative's headline query (RESEARCH_02 §2.5). The denormalized golden search doc:

| Doc field group | Source | Churn | In global doc? |
|---|---|---|---|
| Person identity facets (`full_name`, `job_title`→canonical, `seniority_level`, `department`, location) | `master_persons` ([03:409-417](../03-database-design.md)) | low | **yes** (flatten) |
| Channel-presence facets (`has_email`, `has_phone`, `has_linkedin`) | precomputed booleans ([03:418-419](../03-database-design.md)) | low | **yes** (flatten — no join) |
| **Current-company traits** (`industry`, `employee_band`, `revenue_range`, `technographics`, `hq_country`, `primary_domain`) | `master_companies` via `current_company_id` ([03:390-405,413](../03-database-design.md)) | **low** (firmographics) | **yes** (flatten — this is the join the query needs) |
| Quality/freshness (`data_quality_score`, `is_suppressed` mirror) | `master_persons` ([03:420-421](../03-database-design.md)) | medium | **yes** (filter/badge) |
| Owner / assignment / outreach_status / list membership / per-workspace score | **overlay** ([03:503-505](../03-database-design.md)) | **HIGH + per-tenant** | **NO** — overlay surface only |

- **Why this beats Apollo's wound:** the company firmographics flattened onto the person doc are **low-churn** (a
  company's `employee_band` or `industry` changes rarely), so the restamp fan-out (re-index a company's current employees
  when its firmographic changes) is **bounded and infrequent**, runs as **coalesced `_bulk` CDC writes**
  ([24 §5.1:221-225](../24-advanced-search-exploration-ux.md)), and never touches per-tenant state. The **high-churn,
  high-fan-out** field that destroyed Apollo's index (per-tenant owner) is **architecturally absent** from the shared doc.
- **The denormalization must stay coherent with the edge** (RESEARCH_02 §2.5): when a job change closes one
  `master_employment` edge and opens another, the search doc's `current_company_*` traits must be **recomputed from the
  new current edge in the same CDC propagation** — `current_company_id` is a derived cache, never hand-set, or the grid
  serves "person at the wrong company" (RESEARCH_02 §4, *"the single most expensive correctness bug here"*).
- **The query plan:** filter person facets ∧ current-company-trait facets in **one OpenSearch query** over the flattened
  doc (no query-time join); exact counts for the firmographic facet rail come from **ClickHouse** (§C.3); the page is
  `search_after` + PIT keyset (§B.3); the returned hits are **masked candidate IDs**, hydrated/authorized at the Postgres
  read (§B.5). This is the Siren outcome (fast "person at company with traits") achieved by **pre-joining at index time**
  rather than Siren's query-time join — appropriate because *our* join key (current company traits) is low-churn, whereas
  Apollo's problem field was high-churn.

### C.3 Facet counts — ClickHouse exact where it's load-bearing, OpenSearch approximate where it's not

The §B.2 split maps onto TruePoint as a **correctness rule, not just a perf choice**:

- **Approximate (OpenSearch terms aggs) is fine** for the **filter-rail facet counts shown during exploration** — "~12,400
  in SaaS" can be a shard-local-top-N estimate; the user is browsing, and the number refreshes on each refinement
  ([24 §5:206](../24-advanced-search-exploration-ux.md)). The `doc_count_error_upper_bound` is acceptable here
  ([opensearch terms agg](https://docs.opensearch.org/latest/aggregations/bucket/terms/)).
- **Exact (ClickHouse MV) is mandatory** where the count is **load-bearing for an action or a charge**: the **"Select all
  N results"** total that seeds a bulk reveal/export ([24 §10](../24-advanced-search-exploration-ux.md)) — because that N
  becomes a **credit spend** and a **mutation footprint**. The shipped overlay already separates these: `countContacts`
  returns an **exact, uncapped** total for select-all, while `resolveVisibleIds` is **capped** (`BULK_SELECTION_CAP`) so a
  runaway select-all can never resolve an unbounded id set into one mutation (`searchRepository.ts:287-325`). At Layer-0
  billions, that exact total must come from **ClickHouse**, not an approximate OpenSearch agg
  ([ADR-0035:46-48,85](../decisions/ADR-0035-search-query-and-filter-architecture.md): *"exact facet counts at billions →
  push all counts to ClickHouse"*; [03 §12:750](../03-database-design.md)).
- **Redis caches the facet-count read** with a short per-facet TTL ([24 §5:204-206](../24-advanced-search-exploration-ux.md)),
  guarded by **single-flight + jitter** (§B.4) because a popular query's facet rail is a hot key that thousands of
  concurrent users hit simultaneously ([ADR-0024:27](../decisions/ADR-0024-performance-slos-and-capacity-model.md):
  ≥5,000 concurrent/workspace).

### C.4 Caching + invalidation tied to the write-side events

The brief names the invalidation triggers: **merge / reveal / job-change / job-state events.** Mapping each to the cache
it must invalidate (the `invalidate-on-write` rule, [ADR-0024:29](../decisions/ADR-0024-performance-slos-and-capacity-model.md)):

| Write event | What changed | Cache/index action |
|---|---|---|
| **ER merge / unmerge** (`match_links`) | a golden identity split/merged; `field_provenance` re-materialized (RESEARCH_03 §B.5) | CDC re-indexes the affected golden doc(s) in OpenSearch + ClickHouse; invalidate any cached detail for those master ids |
| **Reveal** (overlay) | a channel copied master→overlay; `is_revealed` flips | **RYOW from Postgres** for the revealing user (§B.6); SSE pushes masked→revealed cell live ([24 §7.5:277](../24-advanced-search-exploration-ux.md)); overlay row re-synced to Typesense |
| **Job change** (`master_employment` close+open) | `current_company_id` + flattened company traits change | recompute the derived cache in-tx, CDC re-index the person doc; surface as a **job-change signal**, never a silent overlay overwrite (RESEARCH_02 §3, U3) |
| **Bulk import burst** (1M rows) | many overlay + golden rows | relax `refresh_interval`, `_bulk` writes, coalesced CDC, **"indexing N new rows…" honesty indicator** ([24 §5.1:221-228](../24-advanced-search-exploration-ux.md)); never silent staleness |
| **Firmographic update** (company trait) | company facet value | bounded CDC fan-out re-indexing the company's **current** employees only (§C.2) — not Apollo's unbounded storm |

The **money/permission paths are explicitly exempt from caching**: the credit balance (`FOR UPDATE`,
[02 §3.1:109-111](../02-architecture.md)) and the suppression/DNC gate (`assertNotSuppressed`,
[02 §3.1:104](../02-architecture.md)) are read in-tx against Postgres every time — *"no unbounded staleness on
money/permission paths"* ([ADR-0024:29](../decisions/ADR-0024-performance-slos-and-capacity-model.md)).

### C.5 Permission re-check at read across the two layers

- **Global masked search (Layer 0):** there is **no per-workspace permission to re-check** — the universe is searchable
  by **access path**, and the doc is masked + PII-free by construction ([03 §9:698](../03-database-design.md)). The only
  read-side gates are: **suppression** (`master_persons.is_suppressed` mirror filters suppressed identities from results
  / blocks reveal, [03:421](../03-database-design.md)) and **region/jurisdiction** residency filtering
  ([03:422](../03-database-design.md)). The hard wall is the **reveal transaction**, where credit + suppression +
  ownership are re-validated in-tx (§C.4).
- **Overlay browse (Layer 1):** **RLS is the hard, fail-closed wall** — `searchRepository` runs every read inside
  `withTenantTx` so a query can **never cross workspaces** (`searchRepository.ts:1-5,259-261`; the `NULLIF(...,'')` GUC →
  zero rows when unset, [03 §9:692](../03-database-design.md)). **Owner/team visibility** (`visibility ∈
  workspace|team|owner`) is re-applied **app-layer at read**, not as an RLS predicate ([03 §9:696](../03-database-design.md);
  the brief's owner-scope rule) — today approximated by the `owner = coalesce(owner_user_id, revealed_by_user_id)` facet
  (`searchRepository.ts:41,206`). Even if a future Typesense overlay adapter stores an owner/visibility ACL on the doc,
  it is a **pre-filter only**; the open-the-record authorization is re-checked against Postgres truth (§B.5).
- **Security precedence (CLAUDE.md):** an eventually-consistent index ACL is never the authority on access; a stale doc
  must not leak a record the truth would deny. Security has final say — the index accelerates, Postgres authorizes.

### C.6 Pre-build thinking pass — the load-bearing read-path answers

1. **Source of truth.** Postgres (golden + overlay) is truth; OpenSearch/Typesense/ClickHouse are **derived projections**
   kept current by CDC < 5 s ([ADR-0024:25](../decisions/ADR-0024-performance-slos-and-capacity-model.md)); Redis caches
   facet counts. Never two independent sources of truth ([24 §5:192-193](../24-advanced-search-exploration-ux.md)).
2. **Failure modes / idempotency.** CDC re-indexing is **idempotent by doc id** (last-write-wins on the projection is
   correct here — the projection has one writer, the search-sync worker); a dropped CDC event is caught by the TTL safety
   net + a periodic full reconcile; a stale facet count is bounded by its short TTL.
3. **Duplicate prevention (read side).** Keyset `search_after` + PIT gives **stable paging with no skip/dupe** under
   concurrent writes ([elastic pagination](https://www.elastic.co/guide/en/elasticsearch/reference/current/paginate-search-results.html));
   offset would skip/dupe (§B.3).
4. **Audit & change history.** Reveal reads/writes audit in-tx ([02 §3.1:113](../02-architecture.md)); masked search is a
   read (no mutation) — but **search-then-reveal** is the audited money path, and the search that *led* to a reveal is
   attributable via `SearchCtx.userId` (`types/src/search.ts:169-175`).
5. **Security (IDOR / exposure).** Global doc carries no workspace_id/owner → nothing to leak cross-tenant; overlay reads
   are RLS-bounded; PII never in the index; permission re-checked at the Postgres read; the index ACL is a pre-filter, not
   the authority (§B.5, §C.5).
6. **Scalability / 10x.** Reads scale on **OpenSearch shards + ClickHouse + Redis + Aurora read replicas**, *never the
   primary writer* ([ADR-0024:34](../decisions/ADR-0024-performance-slos-and-capacity-model.md)); flattened doc = no
   query-time join; keyset = constant paging cost; bounded result sets (`limit ≤ 200`, `types/src/search.ts:157`). What
   breaks first at 10x: the **facet-count hot key** (mitigate: single-flight + jitter + ClickHouse MV) and the
   **firmographic restamp fan-out** (mitigate: low-churn-only flatten + coalesced CDC).
7. **Observability.** CDC lag (search-sync depth/age), facet-count cache hit rate, masked-search p95 vs the 200 ms SLO,
   the "indexing N rows" honesty indicator ([24 §5.1:226-228](../24-advanced-search-exploration-ux.md)).
8. **Rollback.** The whole read model is **derived** → rebuildable from Postgres by re-running search-sync; a bad adapter
   is swapped behind `SearchPort` with **no caller change** (`types/src/search.ts:192-197`; [ADR-0035:83](../decisions/ADR-0035-search-query-and-filter-architecture.md)).
9. **Edge cases.** Empty result (zero hits, valid cursor null); company-less person (no `current_company_id` → company
   facets absent, RESEARCH_02 §2.6); suppressed identity (filtered from global results); just-revealed contact (RYOW from
   Postgres, not the lagging index); concurrent refinement (stale facet count within TTL, refreshes next refinement).

---

## Part D — Tradeoff summary

| Read-path approach | Read latency at billions | Freshness | Fan-out / write cost | Isolation fit | Verdict |
|---|---|---|---|---|---|
| **Query-time join** `master_persons ⨝ employment ⨝ companies` (Postgres or Siren-style) | **slow** (join over billions) / needs a 350-node join engine | strong | none | n/a | **Reject as the default** (Apollo *moved to* this only to escape a *bad* denormalization; for our low-churn join key, pre-join wins) |
| **Flatten everything** incl. per-tenant owner/score onto the global doc | fast | strong-ish | **reindex storm** at fan-out | leaks per-tenant state into shared index | **Reject** (the exact Apollo failure, §A.1) |
| **Postgres-only** ILIKE/GROUP-BY (today's overlay adapter) | fine ≤100M, **strains at billions** with high-card faceting | strong (it *is* truth) | none | RLS-perfect | **Keep as overlay/dev fallback** (`searchRepository.ts`); not the global surface ([ADR-0002 context](../decisions/ADR-0002-search-postgres-then-engine.md)) |
| OpenSearch terms aggs for **all** counts incl. select-all total | fast | < 5s | low | masked-only | **Reject for load-bearing counts** (approximate → wrong credit spend, §C.3) |
| **Flatten low-churn golden traits → OpenSearch (retrieval) + ClickHouse (exact counts) + Typesense (overlay) + Redis (cached counts), keyset+PIT, RYOW from Postgres, permission re-checked at read** | **fast** | < 5s CDC + RYOW strong where needed | **bounded** (low-churn flatten + coalesced CDC) | two surfaces, each correctly isolated | **RECOMMEND** |

---

## Recommendation

**Adopt a two-surface, search-index-as-read-model design — flatten the *low-churn* golden person+company traits into one
masked OpenSearch document for the global "find-anyone" surface, keep all high-churn per-tenant state on the RLS overlay
surface, serve exact load-bearing counts from ClickHouse, cache facet counts in Redis with stampede defenses, page with
`search_after`+PIT, and re-check every permission and every charge against Postgres truth at read.** Concretely, seven
parts, each extending a structure TruePoint already designed rather than inventing a parallel mechanism:

1. **Two read surfaces, never one (§C.1).** A **global masked search** (Layer 0, OpenSearch + ClickHouse, isolated by
   access path, masked + PII-free) and a **per-workspace overlay browse** (Layer 1, Typesense/Postgres, isolated by RLS +
   app-layer owner/team). They have different engines, isolation models, and consistency tiers; the design's first job is
   to route each query to the right surface.

2. **Flatten the *right* fields (§B.1, §C.2).** Denormalize person identity facets + channel-presence booleans
   (`has_email`/`has_phone`, [03:418-419](../03-database-design.md)) + **current-company firmographics** (via the
   `current_company_id` derived cache, [03:413](../03-database-design.md)) into one golden doc so "person at a company with
   these traits" is **one lookup, no query-time join.** Explicitly **exclude** per-tenant owner/assignment/score/list state
   from the global doc — that is the structural fix for Apollo's reindex storm (§A.1, **[VERIFIED — siren.io case study]**).
   The flattened company traits are recomputed from the current edge in the same CDC propagation, never hand-set
   (RESEARCH_02 §2.5).

3. **Engine split by capability (§B.2).** OpenSearch for masked retrieval/filter/typeahead/relevance over the billions-row
   shared index; **ClickHouse for exact high-cardinality facet counts**; Typesense for the per-workspace overlay
   (collection-per-workspace blast-radius isolation, [24 §5.2:237](../24-advanced-search-exploration-ux.md)). This is the
   already-chosen topology ([ADR-0021:72-77](../decisions/ADR-0021-global-master-graph-and-overlay.md)); the research
   confirms it against the billion-row evidence (**[VERIFIED — clickhouse.com matchup]**, **[VERIFIED — opensearch terms
   agg]**).

4. **Exact counts where money/action depends on them; approximate where browsing (§C.3).** OpenSearch terms-agg
   approximation is fine for the exploration filter rail; the **"Select all N" total that seeds a bulk reveal/export must be
   exact (ClickHouse)** because N is a credit spend — extending the shipped exact-`countContacts` / capped-`resolveVisibleIds`
   split (`searchRepository.ts:287-325`) to billions.

5. **Keyset pagination + Redis-cached counts with stampede defense (§B.3, §B.4).** `search_after` + PIT, never offset
   (the shipped overlay adapter is already keyset, `searchRepository.ts:376-403`); facet counts cached in Redis with a
   short per-facet TTL, guarded by **single-flight + TTL jitter** for hot keys at ≥5,000 concurrent/workspace
   (**[VERIFIED — redis.io thundering herd]**; [ADR-0024:27,29](../decisions/ADR-0024-performance-slos-and-capacity-model.md)).

6. **Event-driven invalidation tied to merge/reveal/job-change/import (§C.4).** CDC re-indexes the affected docs (`< 5 s`
   SLO), a reveal is **read-your-own-write from Postgres** + an SSE live cell update, a job change recomputes the derived
   company cache + emits a signal (never a silent overwrite, RESEARCH_02 §3), and a bulk burst shows the **"indexing N
   rows…" honesty indicator** instead of silent staleness.

7. **Permission + charge re-checked at read against truth (§B.5, §C.5).** The index returns **masked candidate IDs**;
   RLS bounds the overlay read; owner/team visibility is re-applied app-layer; the credit balance and suppression gate are
   read **in-tx, never cached** ([02 §3.1:104-111](../02-architecture.md)). An index-side ACL is a pre-filter, never the
   authority (**[VERIFIED — Azure AI Search DLS]**) — security has final say (CLAUDE.md precedence).

This keeps the read path **two-layer-aware** (global masked vs overlay RLS), **scale-safe** (flattened low-churn doc, no
query-time join, keyset paging, exact counts off the columnar store, reads off replicas/index/cache never the primary
writer), and **honest** (eventual consistency where browsing is fine, strong RYOW where the user just wrote, and never a
cached answer on a money or permission decision).

### What this rejects, and why

- **Flattening per-tenant volatile state (owner/assignment/score) onto the global billions-row doc — rejected.** It is the
  **exact Apollo failure** — a frequently-changing field on a 150k-fan-out account triggered *"millions of reindex
  operations … incorrect results, missing data"* (**[VERIFIED — siren.io case study]**). Per-tenant state stays on the
  overlay surface; it is never in the shared index.
- **Query-time joins as the *default* global read path — rejected.** Joining `master_persons ⨝ master_employment ⨝
  master_companies` per query over billions is the cost denormalization exists to avoid (**[VERIFIED — rockset/elastic:
  each join adds significant tax**]); Apollo *adopted* a query-time join engine (Siren) only to escape a *bad*
  denormalization of a high-churn field — for our **low-churn** join key (firmographics) pre-joining at index time is
  strictly better. (Postgres/overlay query-time joins remain correct at ≤100M for the overlay surface.)
- **OpenSearch terms aggregations for *load-bearing* counts — rejected.** They are **shard-local-top-N approximate**
  (`doc_count_error_upper_bound`, **[VERIFIED — opensearch terms agg]**); an approximate "Select all N" would mis-charge a
  bulk reveal. Exact counts come from ClickHouse MVs ([ADR-0035:85](../decisions/ADR-0035-search-query-and-filter-architecture.md)).
- **`from`/`offset` deep pagination — rejected.** O(offset) cost + skip/dupe under concurrent writes (**[VERIFIED —
  elastic/luigisbox]**); the corpus already mandates keyset + PIT ([24 §6:258-266](../24-advanced-search-exploration-ux.md)).
- **Caching the credit balance, the suppression/DNC gate, or any permission decision — rejected.** *"No unbounded staleness
  on money/permission paths"* ([ADR-0024:29](../decisions/ADR-0024-performance-slos-and-capacity-model.md)); these are read
  in-tx with `FOR UPDATE` / `assertNotSuppressed` ([02 §3.1:104-111](../02-architecture.md)). Security has final say.
- **Treating the search-index ACL as the authority on who-can-open-a-record — rejected.** The index is eventually
  consistent; a stale ACL could leak. The index is a **pre-filter**; Postgres truth (RLS + ownership) **authorizes** the
  open/reveal (**[VERIFIED — Azure AI Search: identity remains source of truth]**; [ADR-0035:50-51](../decisions/ADR-0035-search-query-and-filter-architecture.md)).
- **A second, divergent read model (the index becoming a parallel source of truth) — rejected.** Postgres is the system of
  record; the index is a CDC-derived projection, rebuildable from truth (**[VERIFIED — CQRS read model]**;
  [24 §5:192-193](../24-advanced-search-exploration-ux.md)). Never two independent sources of truth.

**Implementation status (gap → work-to-do, not license to skip a rule).** Today **only the Layer-1 overlay-Postgres read
path is built**: `searchRepository` (`packages/db/src/repositories/searchRepository.ts`) does workspace-RLS-scoped ILIKE
search + keyset paging + GROUP-BY facet counts + ILIKE typeahead, and the only shipped `SearchPort` adapter is the
**in-memory dev adapter** (`packages/search/src/index.ts:1-6`). The **global OpenSearch masked index, the ClickHouse exact
facet-count store, the Typesense overlay collections, the Redis facet-count cache, the CDC search-sync worker, and the
flattened golden read doc are all unbuilt** — designed in [ADR-0021:72-77](../decisions/ADR-0021-global-master-graph-and-overlay.md),
[ADR-0035](../decisions/ADR-0035-search-query-and-filter-architecture.md), [03 §12:744-753](../03-database-design.md), and
[02 §3.3](../02-architecture.md), but with no code (RESEARCH_00 §7.1 P8). None of these gaps relaxes a constraint: when
built, the global doc stays **masked + PII-free + workspace_id-free**, the overlay read stays **RLS-FORCED + owner-scoped**,
the credit/suppression checks stay **in-tx and uncached**, and the index stays a **derived projection of Postgres truth**,
never a second source of truth. The BRAINSTORM gate should turn this into concrete options (the flattened doc field list +
mapping, the CDC propagation + restamp-fan-out plan, the Redis key/TTL/stampede policy, the ClickHouse MV set, and the
`SearchPort` OpenSearch/Typesense/ClickHouse adapter seams); the PLAN gate into the index mappings, the search-sync worker
spec, and the cache-invalidation event wiring.
