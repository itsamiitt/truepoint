# ADR-0035 — Search query semantics, autocomplete & filter architecture

- **Status:** Accepted
- **Date:** 2026-06-17
- **Context doc:** [24-advanced-search-exploration-ux.md](../24-advanced-search-exploration-ux.md), [01-tech-stack.md](../01-tech-stack.md), [18-scalability-performance.md](../18-scalability-performance.md)
- **Amends:** [ADR-0002](./ADR-0002-search-postgres-then-engine.md) (adds the autocomplete + query-semantics layer to the `SearchPort` contract), [ADR-0021](./ADR-0021-global-master-graph-and-overlay.md) (specifies *how* the global OpenSearch index serves typeahead, facet counts, and synonym/abbreviation matching)
- **Does not supersede:** the OpenSearch (global) + Typesense (overlay) + ClickHouse (facet counts) topology stands; this ADR builds on it.

## Context

[Doc 24](../24-advanced-search-exploration-ux.md) requires an Apollo/ZoomInfo/Lusha-grade exploration surface:
filter rails built from **search boxes that suggest real indexed values**, queries that **understand
abbreviations** (`CEO` must match "Chief Executive Officer" with no long-form typed), **billions of records
filtered in milliseconds**, and an **instant front end**. [ADR-0021](./ADR-0021-global-master-graph-and-overlay.md)
chose the engines (OpenSearch + Typesense + ClickHouse behind `SearchPort`) but did **not** specify the
query-semantics, autocomplete, or job-title-normalization layer that the user-visible behaviour depends on.

The stack was re-opened for this decision (the choice was treated as genuinely open). Research baseline:
**Apollo** uses Elasticsearch + Siren Federate (~1.2 s complex queries over 210M contacts, 100% of users);
**ZoomInfo** uses Apache Solr's JSON Facet API; **Lusha** is not public. All are Lucene-family engines over a
denormalized read model — the same family as our already-chosen OpenSearch.

## Decision

**1. Engine stack — reaffirm, do not re-platform.** Keep **OpenSearch** (global master graph) + **Typesense**
(per-workspace overlay) + **ClickHouse** (high-cardinality facet counts) behind the existing **`SearchPort`**.
OpenSearch is the Elasticsearch family Apollo proves at this exact workload; switching to Siren Federate or
Solr would be a re-platform with no decisive win and new operational cost.

**2. Autocomplete / suggester layer.** Add `SearchPort.suggest()` and `SearchPort.facetCounts()`. Suggesters
are built per field with **completion suggester** (closed vocab: industry, technology, location),
**edge-ngram** (open vocab: title, skills), or **`search_as_you_type`** (default). Each suggestion returns
`{ value, displayLabel, count, canonicalId? }`. Client rules: **debounce 300 ms, min 3 chars, in-memory cache,
abort-stale**. Targets: typeahead p95 < 50 ms.

**3. Query-semantics layer (abbreviation/synonym expansion).**
- **Query-time `synonym_graph`** token filter (multi-word safe, editable without reindex) in the OpenSearch
  search analyzer, seeded with a curated abbreviation set (CEO⇄chief executive officer, CTO, VP, SDR, …).
- A **canonical job-title taxonomy**: `canonical_titles(id, canonical_label, seniority, function, soc_code)`
  seeded from **O*NET-SOC / ESCO**, plus `title_synonyms(raw_or_alias, canonical_title_id)`. Raw titles are
  normalized to `canonical_title_id` **at index time** (so facet counts + suggestions group by occupation,
  not spelling); typed queries are mapped through the same taxonomy **at query time**.
- **Optional hybrid lexical+vector** path (BM25 + kNN, fused with **RRF**) for long-tail semantic recall,
  behind a flag, deferred to M8+ ([23](../23-ai-intelligence-layer.md)). MVP ships lexical + synonym only.

**4. Facet counts.** ClickHouse `LowCardinality` facet columns + materialized views for exact, fast counts at
billions; OpenSearch terms aggs for the overlay (noting shard-local-top-N approximation). Redis count cache
with a short, per-facet TTL.

**5. Pagination & front end.** Keyset/`search_after` + PIT (never deep offset); virtualized grid; thin column
projection; filter-state serialized to a versioned blob reused by `saved_searches`.

## Rationale

Reaffirming the engine stack avoids a costly migration while matching what Apollo runs in production. The
real gaps were never the engine — they were the **suggester**, **synonym/taxonomy**, and **front-end loading**
layers, which this ADR fills. Query-time synonyms keep the abbreviation dictionary editable without reindex;
index-time canonicalization is what collapses 30 spellings of "CEO" into one clean, countable facet value —
the behaviour the user explicitly asked for. The hybrid-vector path is kept optional so MVP stays simple.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Reaffirm OpenSearch + Typesense + ClickHouse and add suggester + synonym/taxonomy layers (this ADR)** | Chosen | Fills the actual gaps without re-platforming; matches Apollo's engine family; query-time synonyms + index-time canonicalization deliver the CEO→Chief-Executive behaviour. |
| Elasticsearch + Siren Federate (Apollo's exact stack) | Rejected | Federation across sources is not our need (we already build one global golden index via ER); adds licensing/ops cost for no decisive gain. |
| Apache Solr + JSON Facet API (ZoomInfo's stack) | Rejected | Equivalent capability to OpenSearch but means abandoning the already-chosen, already-staffed OpenSearch path. |
| Postgres-only (`pg_trgm` / FTS) for filters + typeahead | Rejected | Serviceable to small scale; strains on high-cardinality faceted/typeahead search at billions ([ADR-0002](./ADR-0002-search-postgres-then-engine.md) context). Kept only as the dev/tiny `SearchPort` fallback. |
| Pure semantic/vector search (embeddings only) | Rejected (as primary) | Great recall, weak on exact filters/counts and far costlier; adopted only as an **optional hybrid** layer (RRF) later. |

## Consequences

- **Positive:** the user-visible filter behaviour (search-box facets, suggestions from real values, CEO→Chief
  Executive Officer, instant grid) is fully specified and reuses the existing stack; no migration; the
  abbreviation dictionary is editable without reindex.
- **Negative (accepted):** new moving parts — a synonym dictionary + a job-title taxonomy to seed and
  maintain, ClickHouse materialized views, and an indexing normalization step in `search-sync`.
- **Mitigation:** taxonomy seeded from public O*NET-SOC/ESCO; synonym set in hot-reloadable config; counts
  cached in Redis; hybrid-vector deferred behind a flag so MVP scope stays bounded.

## Revisit if

- A query shape or scale exceeds OpenSearch's envelope → swap the `SearchPort` impl (no caller changes).
- Synonym/taxonomy maintenance proves too costly → lean harder on the hybrid-vector semantic path.
- Exact facet counts at billions become a bottleneck in OpenSearch → push all counts to ClickHouse.
