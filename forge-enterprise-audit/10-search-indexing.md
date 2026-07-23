# 10 — Search & Indexing

> **Priority:** P1 · **Effort:** 12–16 eng-weeks staged (~3–4 in F2; remainder trigger-gated in F3/F4) · **Phase:** F2 → F4
> (phases are defined in 17-phased-implementation-roadmap.md)

## Executive summary

Search is how the golden dataset Forge produces gets monetized: a prospect record that cannot
be found, filtered, and faceted in under 300 ms is inventory, not product. Search is primarily
a main-platform concern — Forge ships no search surface of its own, and correctly so — but two
things make it a Forge-adjacent audit item: (1) Forge's verified/golden records are exactly
what the global index must serve, and (2) the index-sync pipeline that keeps the index honest
must hang off the same transactional-outbox spine Forge's promotion path already half-built
(see 08-pipeline-architecture.md). Today the platform has the right seam and the wrong engine
plan: a `SearchPort` interface (`packages/types/src/search.ts:192-197`) with an in-memory
dev adapter and a Postgres adapter whose free-text path is leading-wildcard `ILIKE` with no
supporting index (`packages/db/src/repositories/searchRepository.ts:226-234`) — a direct
violation of the platform's own "never LIKE at scale" mandate — while the ratified target
(ADR-0021) prescribes a three-engine topology (OpenSearch + Typesense + ClickHouse) that
2025–2026 research says is over-scoped and partially wrong (Typesense's all-RAM, no-sharding
envelope disqualifies it well before the 100M target). A Typesense container ships in dev
compose with zero adapter code behind it. The headline recommendation is the fixed program
decision (fact pack S.2 #9): a three-phase evolution behind the retained `SearchPort` seam —
**Phase 1 (F2)** engineered Postgres (tsvector+GIN, pg_trgm typeahead, worker-maintained facet
rollup tables; ceiling ~10M; $0) → **Phase 2 (F3)** ParadeDB `pg_search` BM25 + pgvector
inside Postgres (real ranking + hybrid RRF with **no sync pipeline**, because the index lives
in the system of record; ceiling ~30–50M; +$100–300/mo; trigger = ranking pain or 10M rows) →
**Phase 3 (F4)** self-hosted OpenSearch fed by the outbox/CDC spine (30–50M+ records;
$150–400/mo + ~0.25 FTE; tenancy filters injected server-side; alias-based zero-downtime
reindex scripted from day one). Postgres remains the source of truth at every phase; the index
is always a rebuildable projection; dual-writes are banned. The engine swap is non-breaking
because every caller already goes through the seam.

## Current state

### The main platform's search stack (what actually runs)

- **The seam exists and is clean.** `SearchPort` is defined in `@leadwolf/types` with four
  methods — `searchContacts`, `suggest`, `facetCounts`, `index` — and an explicit contract
  that adapters live in `packages/search` and callers never embed engine-specific queries
  (`packages/types/src/search.ts:186-197`). The package barrel restates the seam and names the
  intended future adapters (`packages/search/src/index.ts:1-6`).
- **Two adapters exist: in-memory and Postgres.** The in-memory adapter
  (`packages/search/src/inMemorySearchPort.ts:35-94`) serves dev/tests and documents its own
  limits (range filters and join-backed facets unsupported); its `index()` is a no-op with a
  comment that "real adapters apply CDC changes here" (`inMemorySearchPort.ts:90-93`). The
  production read path is Postgres: `apps/api/src/features/search/searchPortProvider.ts:36`
  builds a workspace-scoped port per request (`apps/api/src/features/search/routes.ts:31`)
  that delegates to `packages/db/src/repositories/searchRepository.ts`, running under
  `withTenantTx` so workspace RLS is the hard boundary (`searchRepository.ts:1-5`).
- **The Postgres adapter is functionally rich but LIKE-shaped.** It covers term facets,
  boolean data signals, numeric ranges, free text, and keyset pagination
  (`searchRepository.ts:7-14`), but term-filter matching is `ILIKE '%value%'` via `ilikeAny`
  (`searchRepository.ts:96-98`, applied at `:114-135`), free text is a six-column
  leading-wildcard `ILIKE` OR-chain over name/title/domain/linkedin
  (`searchRepository.ts:226-234`), and typeahead suggest is a prefix `ILIKE`
  (`searchRepository.ts:471`). No FTS or trigram index exists anywhere in the migration
  history — the GIN indexes that do exist are jsonb/array indexes (`custom_fields`,
  `0003_chunky_vapor.sql:310-311`; `accounts.technologies`, `0004_new_fenris.sql:90`), none of them
  text-search. Every one of these predicates
  is a sequential scan at scale. Facet counts and suggest aggregate live over the full matched
  set per request (`searchRepository.ts:1-2`, `:237-242`).
- **Dead engine infra ships in dev.** A `typesense/typesense:27.1` container is defined in dev
  compose (`docker-compose.yml:23-28`) and `start.sh` writes `TYPESENSE_URL`/`TYPESENSE_API_KEY`
  stubs (`start.sh:43-44`), but `packages/search/src` contains only `fields.ts`, `index.ts`,
  and the in-memory adapter — there is no Typesense (or any engine) adapter in the repo.
- **Master-graph candidate search is an explicit stub.** ADR-0037 routes bulk match-first
  resolution through a `MatchPort` whose master-graph matcher is "infra-gated" on the
  Citus/OpenSearch scale track and "ships as a stub seam until that infra lands"
  (`docs/planning/decisions/ADR-0021-global-master-graph-and-overlay.md:10`).

### The Forge side (what there is to index, and the feed)

Forge has no search of its own: no search code exists in `packages/forge-core`,
`apps/forge-api`, or the console, and the console ships no search/filter/pagination on any
surface (fact pack §5.5; its one list read is even unbounded,
`packages/db/src/repositories/forge/readRepository.ts:131-144`). What Forge produces for the
index is the gold layer: `forge.verified_records` — `content_hash` (globally unique),
`entity_kind`, `fields jsonb`, `confidence`, blind indexes, `is_suppressed`, `version`
(`packages/db/src/migrations/0070_forge_schema.sql:113-133`) — which reaches the searchable
serving surface only by promotion into the `master_*` graph via `forge.sync_outbox`
(`0070_forge_schema.sql:158-172`) and the in-process apply
(`packages/db/src/repositories/forgeSyncRepository.ts`, fact pack §6.1). That feed is
today severed three ways: no producer ever enqueues the sync drain (P-01.4), the outbox
payload carries only `{contentHash, entityKind, emailBlindIndex, phoneBlindIndex}` — no
fields, no resolver keys (fact pack §3.2, §6.1) — and `sync_state`/`master_id_map` never
advance (P-01.20). Gold rows also carry no tenant column at all — they are deliberately
global (fact pack §6.7, P-01.23) — which any index document design must make explicit.

### Intent (planning documents, not reality)

The decision record prescribes: ADR-0002 (Accepted, amended) — self-hosted Typesense from day
one behind the `SearchPort`, synced via logical-replication CDC within ~500 ms
(`docs/planning/decisions/ADR-0002-search-postgres-then-engine.md:16-19`); ADR-0021 (2026-06-09)
— the global master-graph index moves to OpenSearch, Typesense is retained for the
per-workspace overlay, ClickHouse serves high-cardinality facet counts at billions
(`ADR-0021:73-75`); ADR-0035 adds `suggest()`/`facetCounts()` and the query-time
`synonym_graph` + canonical job-title taxonomy (`ADR-0002:8`). None of the engines, none of
the CDC sync, and none of the ClickHouse facet path have been built; the title taxonomy and
the port contract are the parts of ADR-0035 that exist in code. The Forge planning suite
(docs/planning/forge/) assigns search over the golden dataset entirely to the main platform
and gives Forge only operator-console list views (fact pack §2.1, doc 13's ten surfaces).

## Problems identified

- **P-10.1 — GAP · There is no index-sync pipeline, and no indexer, anywhere.** The
  `SearchPort.index()` contract exists but the only implementation is a documented no-op
  (`packages/search/src/inMemorySearchPort.ts:90-93`); the ADR-0002 "search-sync worker
  subscribes to logical replication" (`ADR-0002:18`) was never built; no queue, worker, or CDC
  consumer projects any table into any index. At enterprise scale this is the difference
  between a search product and a demo: the moment an external engine exists, every write path
  (imports, enrichment, Forge promotions, DSAR deletions) must reach it reliably, and
  retrofitting that discipline after volume lands means a full reindex plus a trust deficit.

- **P-10.2 — DEBT · The production search path is unindexed leading-wildcard ILIKE — the
  platform's own "never LIKE at scale" mandate is violated by its only real adapter.** Term
  filters (`searchRepository.ts:96-98`), free text (`:226-234`), and the gate-on email-domain
  leg (`:70`) are all `ILIKE '%…%'`, which no btree can serve, and no tsvector/pg_trgm index
  exists in any migration. Correct today at demo volume; at 1–10M contacts every keystroke
  becomes a multi-second sequential scan holding a tenant transaction open. (The suggest path
  at `:471` is prefix-ILIKE — also unindexable case-insensitively without an expression index.)

- **P-10.3 — GAP · The Forge outbox payload cannot feed an indexer (or its own sync).** Events
  carry no golden fields and no resolver keys — an acknowledged TODO that already makes
  company events unresolvable (apply reports "applied" with no master row, fact pack §6.1) —
  so a projector consuming the outbox cannot build a search document without a read-back join
  into a schema (`forge`) that the main roles cannot read (fact pack §6.4). Compounded by
  P-01.4 (no producer drains the outbox at all) and P-01.20 (`sync_state` never advances),
  the golden dataset is currently unreachable by any index. Fixing the event payload is
  08-pipeline-architecture.md's remit; search inherits the requirement.

- **P-10.4 — RISK · No tenancy/ownership enforcement design exists for an out-of-Postgres
  index.** Today isolation is real only because search runs inside `withTenantTx` under
  workspace RLS (`searchRepository.ts:1-5`). RLS does not follow the data into OpenSearch:
  the FIXED tenancy decision (two-tier, fail-closed) must be re-implemented as server-side
  filter injection on every engine query, and there is no such layer, no isolation test, and —
  because Forge gold carries no tenant column (P-01.23) — no explicit global-vs-workspace
  attribution to filter on. A single missed filter clause in an engine query is a cross-tenant
  data breach in a PII product.

- **P-10.5 — DEBT · Facet counts and typeahead are live full aggregations.** `facetCounts`
  re-runs the matched-set query per facet with the facet's own filter dropped
  (`searchRepository.ts:237-242`) and `suggest` scans with prefix-ILIKE (`:471`). Research
  places full GROUP-BY facet counts at seconds at 10M+ and unusable at 100M without rollups
  (fact pack §11.1). Facet counts are rendered on every search interaction — this is the
  first thing that dies as the dataset grows.

- **P-10.6 — RISK · The ratified ADR-0021 engine topology is wrong for the scale path.**
  Running OpenSearch + Typesense + ClickHouse simultaneously behind one seam triples the
  sync/consistency/ops surface for a 2–3-engineer pod, and Typesense — originally the day-one
  engine (ADR-0002:16) and still slated for the overlay (`ADR-0021:75`) — holds its entire
  index in RAM at 2–3× searchable size with no sharding, which fails the platform's own 100M+
  NFR (fact pack §2.5, §11.1). The ADR needs formal amendment, not silent divergence
  (the same governance failure mode as P-01.30).

- **P-10.7 — GAP · No zero-downtime reindex machinery exists.** Analyzer changes, mapping
  changes, and schema evolution all force full rebuilds; without versioned indices + aliases +
  replay-from-watermark, every such change at 30M+ documents is either downtime or a frozen
  index. This must be scripted from the first day an external engine exists, not retrofitted.

- **P-10.8 — GAP · No semantic/vector capability exists.** pgvector is named as "available
  later" in ADR-0002's consequences (`ADR-0002:40`) but nothing is installed or designed;
  title/company similarity expansion (the highest-value semantic feature for prospect search,
  and a blocking-recall aid for ER — see 05-entity-resolution.md) has no substrate.

- **P-10.9 — DEBT · Dev/prod skew: a Typesense container and env stubs ship with zero code
  behind them.** `docker-compose.yml:23-28` and `start.sh:43-44` advertise an engine the repo
  cannot talk to. Dead infrastructure misleads new engineers into building against the wrong
  target and wastes dev-machine RAM; it should be removed when ADR-0002/0021 are amended.

- **P-10.10 — GAP · The master-graph candidate index for bulk match-first resolution is a
  stub** (ADR-0021:10), which couples import-time resolution quality to this document's Phase
  1/2 work: the same engineered-Postgres (then BM25) indexes that serve user search should
  serve `MatchPort` candidate generation, or imports will keep minting duplicates at volume
  (the Apollo failure mode cited in 01-current-architecture-audit.md, Research).

## Research findings

All load-bearing findings from the R5 research pass (fact pack §11.1), with sources:

- **Postgres FTS ceilings.** `tsvector` + GIN is solid to the low millions, then hits three
  walls: no BM25 (`ts_rank` must fetch every matching tuple to score it — ranking cost grows
  with corpus, not result size), facet counts are full aggregations (seconds at 10M+, unusable
  at 100M without rollups), and GIN update amplification punishes enrichment-heavy write
  workloads (one row update touches many index keys; fastupdate pending lists stall) —
  [pganalyze: Understanding Postgres GIN Indexes](https://pganalyze.com/blog/gin-index);
  [PostgreSQL full-text search docs](https://www.postgresql.org/docs/current/textsearch.html).
  `pg_trgm` typeahead is good to ~10M; high-frequency trigram recheck blowups appear at 100M.

- **ParadeDB `pg_search` (Tantivy-based BM25 inside Postgres).** Production-ready with a V2
  API (late 2025); vendor benchmark on 28M log rows: ranked search 6.28 ms vs ~1,665 ms native
  FTS (~265×) — [ParadeDB: Elasticsearch vs Postgres](https://paradedb.com/blog/elasticsearch-vs-postgres)
  (vendor benchmark, treat as directional). The structural win is BM25 + relational joins +
  RLS in **one system with no sync pipeline** — the index is transactionally consistent with
  the truth. Facet/filter-heavy performance is contested by a competing vendor (TigerData);
  both sides are marketing — **validate on our own 10M-row workload before committing**
  (unverified beyond vendor claims).

- **Vectors in Postgres.** [pgvector](https://github.com/pgvector/pgvector) +
  [pgvectorscale](https://github.com/timescale/pgvectorscale) (StreamingDiskANN + SBQ
  compression) make 10–50M vectors practical on one node; Timescale's vendor benchmark shows
  50M×768d beating Pinecone's s1 pod on p95 by ~28× — vendor-reported. Raw 100M×768d float32
  ≈ 307 GB; Matryoshka truncation to 256–384d + int8/binary quantization brings it to
  25–100 GB. Storage, not compute, is the real cost: embedding 100M records with a self-hosted
  open model is ≈ $40–70 of one-time GPU compute (research-pass estimate, unverified) using
  [BGE-M3](https://huggingface.co/BAAI/bge-m3) (568M params),
  [gte-multilingual-base](https://huggingface.co/Alibaba-NLP/gte-multilingual-base) (305M), or
  [nomic-embed-text](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) (137M).

- **Engine landscape 2025–2026.** Elasticsearch is open source again via AGPLv3
  ([Elastic announcement](https://www.elastic.co/blog/elasticsearch-is-open-source-again));
  OpenSearch moved under the Linux Foundation, Apache-2.0
  ([OpenSearch Software Foundation](https://foundation.opensearch.org/)) — both are safe
  licensing bets. [Typesense](https://typesense.org/docs/guide/system-requirements.html) keeps
  the whole index in RAM (≈2–3× searchable size) and does not shard — wrong for 100M.
  [Meilisearch](https://www.meilisearch.com/docs/learn/resources/known_limitations) is
  single-node and by its own documentation degrades past ~100M documents — a mid-scale tool.
  Quickwit was [acquired by Datadog](https://quickwit.io/blog/quickwit-joins-datadog)
  (Jan 2025) and is logs-shaped — avoid. [Vespa](https://vespa.ai/) is the strongest engine at
  100M+ but its ops complexity is unstaffable for a 2–3-engineer pod.
  [Manticore](https://manticoresearch.com/) is a viable budget hedge with a thin ecosystem.

- **Index-sync canon.** Never dual-write from the request path (the classic
  torn-write/ordering bug class). The canonical feeds are CDC
  ([Debezium architecture](https://debezium.io/documentation/reference/stable/architecture.html))
  or — lighter, and already the platform's committed pattern — a
  [transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html)
  drained into a queue-backed indexer performing idempotent upserts keyed
  `(record_id, version/LSN)`. Zero-downtime reindex = versioned indices behind an
  [alias](https://www.elastic.co/guide/en/elasticsearch/reference/current/aliases.html):
  build `v(n+1)` from a snapshot watermark, replay events past the watermark, swap the alias,
  keep `v(n)` for rollback — scripted from day one.

- **Hybrid retrieval.** Reciprocal Rank Fusion with k≈60 is the settled default fusion
  ([Cormack et al., SIGIR 2009](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf));
  OpenSearch ships it natively
  ([hybrid search docs](https://opensearch.org/docs/latest/search-plugins/hybrid-search/)).
  Pattern: top-50–100 BM25 ∪ top-50–100 dense → RRF → optional cross-encoder on the top 10.
  For prospect search, BM25 stays primary; vectors serve title/company similarity expansion.

## Enterprise best practices

The ZoomInfo/Apollo/LinkedIn-class bar for this concern: (1) **the index is always a derived,
rebuildable projection** — the OLTP store is truth, and a full reindex is a routine scripted
operation, not an incident; (2) **search infrastructure is dedicated and sharded** at the
100M+ tier — ZoomInfo runs Solr for serving-side match with nickname expansion (fact pack
§8.5), and nobody serious runs LIKE; (3) **facets are precomputed or engine-aggregated**,
never OLTP GROUP-BYs on the hot path; (4) **tenant/visibility filters are injected
server-side into every engine query** and covered by isolation tests, because the engine has
no RLS; (5) **PII never enters the index** — documents carry masked presence booleans,
domains, and verification states, not addresses or numbers (the platform's `MaskedContact`
posture, and Forge's blind indexes, already encode this rule — the index must inherit it);
(6) **freshness is an SLO** (commit→searchable lag measured and paged on), because sellers
act on what they can find; (7) **deletion reaches the index** — suppression and DSAR erasure
project as deletes with a reconciliation sweep proving it (FIXED decision 8; fact pack §9.6
names the index as a DSAR store); and (8) **ranking changes are evaluated against a golden
query set** before rollout, exactly like parser changes (18-testing discipline in the Forge
suite). The candidate-generation side of ER shares the same index discipline: Apollo's
duplicate epidemic came from ingestion without a resolution gate, and the gate needs a
candidate index to hit (see 05-entity-resolution.md).

## Recommended architecture

Adopt the fixed three-phase evolution (fact pack S.2 #9) behind the existing `SearchPort`
seam. Postgres stays the source of truth at every phase (FIXED decision 3); each phase is a
new adapter, not a new contract; the ADR-0021 tri-engine topology is formally amended down to
this path (OpenSearch survives as the Phase-3 endgame; Typesense and the ClickHouse facet
tier are dropped — ClickHouse remains in the stack for telemetry per 09-storage-strategy.md,
and can serve billions-scale facet counts later if Phase 3's aggregations ever miss SLO).

```text
                     Query surface (unchanged at every phase)
   apps/web /prospects ─► apps/api /api/v1/search/* ─► SearchPort (packages/types/src/search.ts:192)
                                        │
        ┌───────────────────────────────┼───────────────────────────────────────┐
        │ PHASE 1 · F2                  │ PHASE 2 · F3                          │ PHASE 3 · F4
        │ Engineered Postgres           │ ParadeDB pg_search + pgvector         │ Self-hosted OpenSearch (3-node)
        │ tsvector+GIN · pg_trgm        │ BM25 + RRF hybrid IN Postgres         │ CDC/outbox-fed projection
        │ facet ROLLUP tables           │ (no sync pipeline; RLS still applies) │ server-side tenancy filters
        │ (worker-maintained)           │ trigger: ranking pain OR 10M rows     │ alias-versioned indices
        │ ceiling ~10M · $0             │ ceiling ~30–50M · +$100–300/mo        │ 30–50M+ · $150–400/mo + ~0.25 FTE
        └───────────────┬───────────────┴──────────────────┬────────────────────┴──────────────▲
                        │ same tables, better indexes      │ same tables, better index type    │ bulk upserts,
                        ▼                                  ▼                                   │ external versions
   ┌─────────────────────────────────────────────────────────────────────┐          ┌──────────┴─────────┐
   │ POSTGRES = TRUTH                                                    │          │ search-index worker │
   │ overlay: contacts/accounts (RLS)  ·  Layer 0: master_* (global)     │ outbox   │ (apps/workers,      │
   │ forge.verified_records ──promotion──► forge.sync_outbox ──apply──►  │─events──►│ BullMQ, idempotent, │
   │ master_* (fact pack §6.1; producer fixed in F1 per P-01.4)          │          │ keyed record+version│
   └─────────────────────────────────────────────────────────────────────┘          └────────────────────┘
```

### The index-sync spine (all phases; built once in F2)

One rule: **a search-visible write is not done until its index event is committed in the same
transaction.** The mechanism is the transactional outbox 08-pipeline-architecture.md mandates
everywhere, reusing the platform's existing `outboxRelay` worker pattern (ADR-0027, fact pack
§2.3) rather than inventing a third relay — the P-01.31 anti-duplication discipline applies to
search plumbing too.

- **Producers.** (a) Overlay writes (imports, enrichment, user edits) append an index event in
  the same `withTenantTx`. (b) The Forge→master apply (`forgeSyncRepository.applyItem`, under
  `withErTx`) appends an index event for the touched `master_*` record in the same transaction
  — this makes the indexer a *second consumer* of Forge's promotion flow without touching the
  `forge` schema's isolation wall. (c) Suppression/DSAR erasure appends `op: "delete"` events
  (see 07-data-governance.md).
- **Consumer.** A `search-index` BullMQ queue in `apps/workers` with the platform's retry/DLQ
  conventions. In Phases 1–2 its only job is facet-rollup maintenance (the "index" is Postgres
  itself); in Phase 3 it becomes the OpenSearch projector. Idempotency: upserts keyed
  `(doc_id, version)` with external-version semantics (`version_type: external_gte`), so
  redelivery and out-of-order application converge — at-least-once + idempotent apply,
  invariant (3) of the Forge suite.
- **Escalation trigger.** When the outbox has ≥2 independent consumer *systems* (master-apply
  + indexer + anything else), move the feed to WAL-based CDC (Sequin or pgstream, fact pack
  §7.6) — an F3 decision owned by 08-pipeline-architecture.md; the indexer's contract
  (events keyed by record+version) is deliberately identical under either feed.
- **Reconciliation.** A nightly leader-locked sweep diffs Postgres vs the index (counts per
  scope + sampled content checksums) and re-projects drift — the self-healing pattern for
  multi-store consistency (fact pack §10.6), and the mechanism that makes "deletion is real"
  provable in the index (FIXED decision 8).

### The event and indexer contracts

```ts
// packages/types/src/searchIndexing.ts (new)
export interface SearchIndexEvent {
  eventId: string; // outbox row id — consumer dedup key
  entity: "master_person" | "master_company" | "contact" | "account";
  recordId: string; // PK in the owning table
  version: number; // monotonic per record; adapter applies external_gte semantics
  op: "upsert" | "delete"; // delete = suppression, DSAR erasure, tombstone
  scope:
    | { kind: "global" } // Layer-0 master graph (Forge-fed) — no tenant
    | { kind: "workspace"; tenantId: string; workspaceId: string };
  occurredAt: string; // ISO-8601, for freshness SLO measurement
}

export interface SearchIndexer {
  /** Idempotent batch apply; safe under redelivery and reordering. */
  apply(events: SearchIndexEvent[]): Promise<void>;
  /** Rebuild one entity's index from a snapshot watermark, then replay (alias cutover). */
  rebuild(entity: SearchIndexEvent["entity"], watermarkEventId: string): Promise<void>;
}
```

### Index document design (lean, denormalized, masked)

One `person_search` document per golden person (and `company_search` per company), built at
projection time by joining person + current employment + company — denormalization happens in
the projector, never in the OLTP schema. The document is **lean**: masked presence booleans
and derived facets only; raw emails, phones, blind indexes, and raw payloads never leave
Postgres (the `MaskedContact` rule extended to the index; the blind-index unification of
P-01.6 stays entirely out of scope for search).

```jsonc
// person_search v1 (mapping sketch — OpenSearch keyword/text/boolean/date types)
{
  "doc_id": "mp_…",                    // master_persons.id (global) | contacts.id (overlay)
  "scope": "global",                   // "global" | "workspace" — EXPLICIT, never inferred (P-01.23)
  "tenant_id": null,                   // required non-null when scope=workspace
  "workspace_id": null,
  "version": 7,                        // monotonic — the idempotency key with doc_id
  "full_name": "…",                    // text, analyzed
  "title_raw": "…",                    // text
  "title_canonical_id": "ceo",         // keyword — ADR-0035 taxonomy id (query-time synonyms)
  "seniority": "c_suite",              // keyword facet
  "department": "executive",           // keyword facet
  "location_city": "…", "location_country": "…", // keyword facets
  "company": { "name": "…", "domain": "…", "industry": "…", "headcount_bucket": "51_200" },
  "has_email": true, "has_phone": false,          // booleans — NEVER values
  "email_status": "valid",             // verification state (04-data-quality-framework.md)
  "confidence_band": "high",           // Forge promotion confidence, bucketed
  "verified_at": "2026-07-01T00:00:00Z",
  "freshness_score": 0.92,             // decay-adjusted (04); a ranking signal
  "linkedin_slug": "…",               // keyword — public identifier, candidate-match key
  "updated_at": "2026-07-20T00:00:00Z"
  // Phase 2+: "title_embedding": [ … 256–384d int8 … ] (pgvector column / kNN field)
}
```

### Tenancy and visibility in the engine (Phase 3's hard requirement)

Two structural rules replace RLS outside Postgres: (1) **separate indices per universe** —
`persons_global_vN` (Forge-fed master graph, no tenant data beyond masked fields) and
`persons_overlay_vN` (workspace-scoped) — so a filter-construction bug cannot cross the
global/overlay boundary, structurally mirroring the `master_*`-vs-overlay split (FIXED
decision 2); and (2) **the adapter injects scope filters from `SearchCtx` on every query** —
`term: {workspace_id}` on overlay queries, and reveal/ownership-aware masking on global-universe
queries — with the adapter's constructor requiring ctx (type-enforced, same shape as
`SearchCtx` today, `packages/types/src/search.ts:169`) and a CI isolation test asserting a
workspace-A query can never return a workspace-B document. Security has the final say on this
design before any cutover (see 13-security.md).

### What is deliberately not built

Typesense as any production tier (RAM/sharding envelope, P-10.6); Meilisearch (mid-scale
dead end); Quickwit (Datadog-owned, logs-shaped); Vespa (unstaffable); Elasticsearch (no
advantage over OpenSearch here given AWS-ecosystem tooling and Apache-2.0); a ClickHouse facet
tier (rollups + engine aggregations cover the audited scale; retained as an F4+ option in
ADR-0021's spirit); and any dual-write from request paths, ever.

## Implementation details

Dependency-ordered. Forge-side prerequisites (F1): P-01.4 (sync producer/scheduler), P-01.20
(sync_state advancement), and the outbox payload completion (S.2 #3) are owned by
08-pipeline-architecture.md and block only the *global-universe* feed — Phase 1 overlay work
has no Forge dependency.

**Phase 1 — Engineered Postgres (F2, ~3–4 eng-weeks, $0 infra)**

1. Migration `packages/db/src/migrations/007x_search_fts.sql` (hand-authored — drizzle-kit
   generate is unsafe in this repo, fact pack §2.3): `CREATE EXTENSION IF NOT EXISTS pg_trgm;`
   a `search_tsv tsvector GENERATED ALWAYS AS (…) STORED` column on `contacts` weighting
   name (A), job_title (B), email_domain/linkedin (C); GIN index on it; trigram GIN expression
   index on `coalesce(first_name,'')||' '||coalesce(last_name,'')` and on `accounts.name`.
   Note: `CREATE INDEX CONCURRENTLY` cannot run inside a transaction — verify
   `applyMigrations.ts` transaction semantics and, if migrations are transactional, split
   index creation into a documented non-transactional step in the deploy runbook.
2. Rewrite the LIKE paths in `packages/db/src/repositories/searchRepository.ts`: free text
   (`:223-235`) becomes `search_tsv @@ websearch_to_tsquery('simple', $q)` OR a trigram
   similarity clause for short/fuzzy inputs; suggest (`:471`) becomes trigram-backed prefix
   match; term-facet `ilikeAny` (`:96-98`) becomes equality/ANY on normalized keyword columns
   where exact (seniority, department, canonical title id) and trigram where genuinely fuzzy.
   The provider and routes (`apps/api/src/features/search/*`) do not change — the seam holds.
3. Facet rollups: migration `007y_search_facet_rollups.sql` —

   ```sql
   CREATE TABLE search_facet_rollups (
     workspace_id uuid NOT NULL,          -- all-zeros sentinel row-set for the global universe
     facet_field  text NOT NULL,          -- FacetKey
     facet_value  text NOT NULL,          -- normalized key
     display_label text NOT NULL,
     hit_count    bigint NOT NULL DEFAULT 0,
     refreshed_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (workspace_id, facet_field, facet_value)
   );
   ```

   plus `packages/db/src/repositories/searchFacetRollupRepository.ts` and an `apps/workers`
   repeatable job (`search-facet-rollup`, leader-locked, platform retry/DLQ conventions) doing
   incremental maintenance from index events + a nightly full rebuild. `facetCounts` serves
   from rollups above a matched-set threshold (~100K rows) and live below it — unfiltered
   facet counts (the expensive case) become O(1) reads.
4. The index-event spine: `packages/types/src/searchIndexing.ts` (contracts above); outbox
   appends in overlay write repositories and in `forgeSyncRepository.applyItem` (same-tx);
   `apps/workers/src/queues/searchIndex.ts` consumer registered with `removeOnComplete/Fail`
   set (the forge queues' omission, P-01.17, is not repeated). In Phase 1 it feeds only rollup
   maintenance — but the spine, metrics, and DLQ exist from day one.
5. Cleanup: delete the Typesense service from `docker-compose.yml:23-28` and the env stubs
   from `start.sh:43-44`; amend ADR-0002/ADR-0021 with the three-phase decision (P-10.6, the
   governance half); record the amendment in `docs/planning/decisions/`.
6. Tests: itests for FTS/trigram correctness and plan shape (no seq scans on the hot paths,
   asserted via `EXPLAIN (FORMAT JSON)`), rollup convergence, and event idempotency — search
   gains real CI coverage before any engine exists (the P-01.28 lesson).

**Phase 2 — ParadeDB pg_search + pgvector (F3, ~4–5 eng-weeks, +$100–300/mo)**

1. Validation spike first (~1 week): load a 10M-row synthetic corpus, benchmark BM25 ranking,
   filtered search, and facet aggregations against Phase-1 numbers on our query shapes — the
   TigerData-contested facet claims are verified or refuted here before commitment.
2. Infra: run Postgres with the `pg_search` + `pgvector` extensions (ParadeDB ships a Postgres
   image; on the single-VM deploy this is an image swap in `docker-compose.prod.yml` with a
   staging soak — coordinate with 09-storage-strategy.md's Postgres plan). Cost is the larger
   instance, not a new system.
3. Migration `008x_search_bm25.sql`: `CREATE INDEX … USING bm25` over the search projection
   columns; `vector(384)` embedding column + pgvectorscale index on the serving tables.
4. `packages/db/src/repositories/searchRepositoryBm25.ts` implementing the same internal
   interface as `searchRepository.ts`; `apps/api/src/features/search/searchPortProvider.ts`
   selects it behind a per-workspace flag (`SEARCH_BM25_ENABLED`); hybrid = top-100 BM25 ∪
   top-100 vector kNN → RRF (k=60) in SQL. RLS still applies — no sync pipeline exists to
   break, which is the entire point of this phase.
5. Embedding backfill job in `apps/workers` (model/runtime/batching owned by
   11-ai-assisted-processing.md; quantized 256–384d per the storage math in §Research);
   embeddings refresh only on title/company change, driven by the same index events.
6. Wire `MatchPort` candidate generation (P-10.10) to the BM25/trigram indexes — import-time
   resolution and user search share one candidate substrate (see 05-entity-resolution.md).

**Phase 3 — Self-hosted OpenSearch (F4, ~5–7 eng-weeks + ~0.25 FTE ongoing, $150–400/mo)**

1. Trigger check (gate, not calendar): sustained 30–50M+ indexed records, or facet/search p95
   SLO misses on Phase 2, or aggregation shapes Postgres cannot serve (see
   14-performance-scaling.md's volume model).
2. Infra: 3-node OpenSearch in `docker-compose.prod.yml` (or its successor per deploy
   evolution) **with explicit resource limits** — the forge services' missing-limits mistake
   (fact pack §4.4) is not repeated on the JVM that will actually eat the VM; snapshots to the
   R2 bucket (09-storage-strategy.md); dashboards/alerts per 12-observability.md.
3. `packages/search/src/openSearchAdapter.ts` — a pure engine client implementing `SearchPort`
   (the package's no-db-import rule, `searchRepository.ts:4-5`, is why the adapter lives here
   and the projector lives in workers); scope-filter injection per §Recommended architecture.
4. `apps/workers/src/queues/searchIndex.ts` becomes the real projector: batch `_bulk` upserts,
   `version_type: external_gte` keyed on `SearchIndexEvent.version`, deletes for
   suppression/DSAR, DLQ + redrive per platform convention.
5. Reindex tooling `scripts/search-reindex.ts`: create `persons_global_v(n+1)`, bulk-load from
   a Postgres snapshot watermark, replay outbox events past the watermark, verify counts +
   sampled checksums, atomically swap the read alias, retain v(n) for rollback. Exercised in
   staging on every mapping change; run quarterly in production as a fire drill.
6. Cutover per-workspace behind the provider flag; the Phase-2 adapter remains the fallback
   for at least one release cycle.

## Migration strategy

- **Phase 0 → 1 (in-place in Postgres).** Additive migration (generated column + indexes
  build without blocking writes when done concurrently); the new query path ships dark behind
  `SEARCH_FTS_ENABLED`; a shadow-compare mode logs result-set diffs between the ILIKE path and
  the FTS path on sampled real queries (expect *better* recall from synonym/stemming — diffs
  are reviewed, not assumed regressions); per-workspace rollout; rollback = flag off (the
  ILIKE code path is retained until Phase 1 exits, then deleted). No data migration at all.
- **Phase 1 → 2.** Extension installed and soaked in staging first; BM25 index built
  concurrently alongside the live FTS indexes (both coexist); per-workspace flag cutover with
  a golden-query-set ranking eval (nDCG@10 vs judged baseline) as the gate; rollback = flag
  off, drop the BM25 index at leisure. The Phase-1 rollup tables stay — they remain the facet
  fallback and the global-universe counter source.
- **Phase 2 → 3.** The outbox/CDC feed dual-projects to OpenSearch while Postgres remains the
  serving path (one producer, two consumers — this is the moment the CDC upgrade decision in
  08-pipeline-architecture.md fires); backfill via snapshot + replay; a dual-read shadow phase
  compares hit counts, top-k overlap, and latency per query class; per-workspace cutover;
  rollback = repoint the provider to the Phase-2 adapter (which never stopped working, because
  Postgres never stopped being truth). Alias-versioned indices from the first document ever
  written — there is no "v1 without aliases" stage.
- **At no phase** does a request handler write to two stores; at no phase does an index
  outage lose data (re-enqueue from the outbox/PG is the recovery path, matching the
  platform's "Redis wipe is a non-event" doctrine in 08-pipeline-architecture.md).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ParadeDB facet/aggregation maturity below our shapes (vendor dispute unresolved) | Medium | Medium — Phase-2 ceiling arrives early | 10M-row validation spike gates adoption; Phase-1 rollup tables remain correct fallback; OpenSearch phase pulls forward on failure |
| OpenSearch ops burden overwhelms a 2–3-eng pod | High | Medium | Trigger-gated (not calendar); 3-node with resource limits + snapshot/restore runbooks; ~0.25 FTE explicitly budgeted (15-cost-optimization.md); Phase-2 fallback kept warm |
| Index/Postgres divergence (missed or reordered events) | Medium | High — ghost/stale/missing prospects erode trust | Same-tx outbox (never dual-write); external-version idempotent upserts; nightly reconciliation sweep + drift metric + rebuild runbook |
| Cross-tenant leakage via missing filter in the external engine | Low | Critical — PII breach | Separate global/overlay indices (structural); ctx-typed adapter injects filters; CI isolation tests; 13-security.md sign-off gates cutover |
| PII enters index documents | Low | Critical — index becomes a DSAR store with raw PII | Lean masked document contract in `@leadwolf/types`; projector CI test asserts no email/phone-shaped values; DSAR executor enumerates the index regardless (07-data-governance.md) |
| Forge feed stays severed (P-01.4/P-10.3) and the global universe never populates | Medium (until F1 lands) | High — Phase 3 indexes an empty master graph | F1 fixes are prerequisites tracked in 17-phased-implementation-roadmap.md; search work sequences overlay-first so it never blocks on Forge |
| Embedding storage/cost blowout at 100M vectors | Medium | Medium | Quantized 256–384d (25–100 GB not 307 GB); embed only on Phase-2 trigger; refresh only on field change; cost model in 15-cost-optimization.md |
| Eventual consistency confuses users editing overlay records | Medium | Low | Read-your-writes: overlay CRUD reads from Postgres; the index serves discovery only; freshness SLO + UI staleness hint if lag breaches |
| GIN update amplification degrades enrichment write throughput in Phase 1 | Medium | Medium | Monitor write latency on enrichment batches; `fastupdate`/`gin_pending_list_limit` tuning; BM25 phase removes tsvector churn for ranking |

## Success metrics

- **Latency:** text+filter search p95 < 300 ms at 10M records (Phase-1 exit), < 200 ms at
  30M (Phase-2 exit), < 300 ms at 100M including facets (Phase-3 steady state); typeahead
  p95 < 100 ms at every phase.
- **Facets:** facet-count render p95 < 500 ms at every scale (rollups or engine aggregations
  — never OLTP GROUP-BY on the hot path).
- **Freshness:** commit→searchable lag p95 < 60 s, p99 < 5 min; `search_index_oldest_pending_seconds`
  paged at 15 min (metric catalog in 12-observability.md).
- **Correctness:** zero cross-tenant hits in continuous CI isolation tests; reconciliation
  drift < 0.01% of documents per nightly sweep, self-healed; suppression/DSAR deletes visible
  in the index within the same freshness SLO (deletion is real, FIXED decision 8).
- **Quality:** golden query set (≥200 judged queries) nDCG@10 regression gate on every
  adapter/ranking change; no cutover below the prior adapter's baseline.
- **Hygiene:** zero `%…%` LIKE/ILIKE predicates in production search query plans
  (pg_stat_statements audit); zero dual-writes (enforced by review + the absence of any
  engine client import in request handlers).
- **Cost ceilings:** Phase 1 $0 incremental infra; Phase 2 ≤ $300/mo; Phase 3 ≤ $400/mo
  + ≤ 0.25 FTE ops (15-cost-optimization.md tracks actuals).

## Effort & priority

**P1, staged F2→F4, ~12–16 eng-weeks total for the 2–3-engineer pod (~3–4 in F2).** It is not
P0 because nothing about search blocks correctness — the F1 program (01-current-architecture-audit.md)
owns the pipeline breaks, and today's volumes survive the ILIKE adapter. It cannot be P2
because the current query path has a hard ~1–10M ceiling (P-10.2, P-10.5) that arrives with
the first serious import wave, and because the index-sync spine must be designed *with* the F2
outbox work (08-pipeline-architecture.md) — bolting an indexer onto a finished pipeline later
means re-touching every write path. The phase split matches the fixed roadmap: engineered
Postgres and the event spine in F2, ParadeDB validation and adoption in F3 at the stated
trigger (ranking pain or 10M rows), OpenSearch in F4 at 30–50M+ — each phase is
independently shippable, each rollback is a flag, and the seam guarantees no caller ever
changes.

## Future enhancements

- **Natural-language search over the golden dataset** — the platform already has the
  Anthropic NL seam (`nlSearchAdapter`, ADR-0023; fact pack §2.3) producing structured
  filters; wiring it to emit `ContactQuery` against the same `SearchPort` is a product
  feature, not an infrastructure change.
- **Cross-encoder reranking of the top-10** and learned-to-rank signals (click/reveal
  feedback loops) once outcome labels accumulate (11-ai-assisted-processing.md).
- **ClickHouse facet tier at billions** — the retained sliver of ADR-0021's original
  topology, warranted only if Phase-3 aggregations miss SLO at extreme cardinality; the
  telemetry ClickHouse from 09-storage-strategy.md would host it.
- **Shared ANN blocking for ER** — the Phase-2 embedding columns double as semantic blocking
  keys for entity resolution recall (05-entity-resolution.md), one substrate serving both.
- **Saved searches and alerting** ("new CFOs at fintech companies in Berlin this week") —
  standing queries evaluated on index events; a natural consumer of the same spine.
- **Multilingual analyzers and locale-aware normalization** when i18n expands the corpus
  beyond English-dominant profiles (the `'simple'` FTS config is the deliberate v1).
- **Per-tenant ranking boosts and suppression-aware personalization** — enterprise accounts
  will ask; the document schema's `scope`/facet fields already carry what's needed.
