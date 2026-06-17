# ADR-0021 — Global master data graph + per-workspace overlay (two-layer model)

- **Status:** Accepted
- **Date:** 2026-06-09
- **Context doc:** [02-architecture.md](../02-architecture.md), [03-database-design.md](../03-database-design.md), [06-enrichment-engine.md](../06-enrichment-engine.md), [08-compliance.md](../08-compliance.md)
- **Reopens / amends:** [ADR-0006](./ADR-0006-per-workspace-multitenant-model.md) (the *no-global-golden-record* clause; the per-workspace **overlay** stands)
- **Revives (as a deliberate hybrid):** [ADR-0005](./ADR-0005-multi-tenancy-and-global-contact-db.md) (global contact DB), [ADR-0003](./ADR-0003-three-layer-data-model.md) (raw/provenance/golden layering)
- **Amends:** [ADR-0002](./ADR-0002-search-postgres-then-engine.md) (global search index → OpenSearch), [ADR-0015](./ADR-0015-entity-resolution-dedup-engine.md) (entity resolution now **global/cross-source**)
- **Amended by:** [ADR-0035](./ADR-0035-search-query-and-filter-architecture.md) (2026-06-17) — specifies *how* the global OpenSearch index serves **typeahead suggestions**, **facet counts** (ClickHouse `LowCardinality` + materialized views), and **abbreviation/synonym matching** (CEO→Chief Executive Officer) via a query-time `synonym_graph` + a canonical job-title taxonomy. Topology (OpenSearch + Typesense + ClickHouse) unchanged.

## Context

[ADR-0006](./ADR-0006-per-workspace-multitenant-model.md) repositioned LeadWolf from a **global data
vendor** to a **per-workspace prospecting CRM**: each workspace owns isolated copies of contacts/accounts,
sourced by import + third-party enrichment, with **no shared golden record**. It explicitly *rejected* the
hybrid (global golden + per-workspace overlay) for complexity, and listed *"the lack of a shared asset
becomes painful"* as the condition to **revisit**.

That condition is now in force. The product direction requires a **searchable universe** of people and
companies — *millions of users filtering billions of records*, find-anyone-then-reveal — which the
per-workspace model cannot provide (a workspace can only search what it already imported). This is the
**data-vendor capability** ADR-0006 traded away. We add it back **without** giving up the per-workspace
curation/billing/compliance the rest of the corpus depends on. The earlier global designs
([ADR-0005](./ADR-0005-multi-tenancy-and-global-contact-db.md) /
[ADR-0003](./ADR-0003-three-layer-data-model.md)) are the starting point, now combined deliberately as a
**two-layer** model rather than chosen exclusively.

## Decision

Adopt a **two-layer data model**:

**Layer 0 — global master graph (the shared universe).** A globally entity-resolved, billions-scale
dataset of people and companies, owned by the **system** (not RLS-workspace-scoped), holding **golden
records** + the raw evidence they are built from:

- `master_persons`, `master_companies` — golden records (survivorship-merged).
- `master_emails`, `master_phones` — per-person verifiable contact channels (status + freshness).
- `master_employment` — person↔company edges (current + past; title, dates, `is_current`) — **this is the
  prospect↔company link** (resolved primarily by email-domain → company `primary_domain`/`alt_domains`).
- `source_records` — immutable per-source raw evidence (provenance/lineage) feeding resolution.
- `match_clusters` / `match_links` — entity-resolution output (cluster membership + match probabilities;
  `is_duplicate_of`).

**Layer 1 — per-workspace overlay (curation + billing + compliance).** The existing `contacts`/`accounts`
([03 §5](../03-database-design.md#5-data-layer)) become **overlays** referencing a `master_person_id` /
`master_company_id` and carrying only **workspace-private** state (notes, lists, scores, `outreach_status`,
reveal ownership). Everything ADR-0006/0007/0009/0013 locked stands: **reveal** still spends tenant credits
**first-reveal-wins per workspace** ([ADR-0007](./ADR-0007-per-workspace-reveal-and-credit-counter.md)) — it
now unlocks the **master** verified channel into the overlay; **suppression/consent** gate reveal **and**
send, now enforced at the **global** layer as well.

**Entity resolution is global/cross-source** (amends [ADR-0015](./ADR-0015-entity-resolution-dedup-engine.md)):
deterministic match keys (email blind index, registrable domain, LinkedIn id, E.164 phone) for the common
case; **blocking + MinHash/LSH** candidate generation to avoid O(n²) at billions; **Splink** probabilistic
scoring for the fuzzy tail; survivorship → golden record.

**Search/analytics topology** (amends [ADR-0002](./ADR-0002-search-postgres-then-engine.md)): the **global**
masked search index moves to **OpenSearch** (sharded inverted index, facet aggregations, `search_after`
cursoring) behind the existing `SearchPort`; **ClickHouse** serves high-cardinality facet counts at billions;
**Typesense** is retained for the smaller per-workspace overlay / dev. Golden OLTP stays on Postgres, sharded
with **Citus** when it crosses single-writer limits; raw `source_records` + batch ER live in an **S3 +
Iceberg** lake (Splink on Spark/Athena). Scale target rises **100M+ → billions**.

## Rationale

The hybrid is the only model that delivers *both* a shared searchable asset *and* per-team
curation/honest-billing/provable-deletion. Splitting **system-owned golden layer** from **RLS overlay** keeps
tenant isolation intact (a workspace still only sees its own overlay + masked global search) while letting one
entity-resolution pipeline dedup the universe once. The reveal/credit/suppression machinery is unchanged in
spirit — reveal simply sources its verified value from the master channel — so [ADR-0007](./ADR-0007-per-workspace-reveal-and-credit-counter.md)/[ADR-0009](./ADR-0009-outreach-engine-enroll-and-send.md)/[ADR-0013](./ADR-0013-charge-for-verified-data-credit-back.md)
survive. A global golden record actually makes **DSAR deletion *more* provable** (one identity to find and
purge, then cascade to overlays) than enumerating copies.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Two-layer: global master graph + per-workspace overlay (this ADR)** | Chosen | Shared searchable universe **and** per-team curation/billing/compliance; one global dedup; deletion provable via the golden identity. |
| Per-workspace only ([ADR-0006](./ADR-0006-per-workspace-multitenant-model.md) as-was) | Rejected | A workspace can only search what it imported — no "find anyone" universe; the capability the product now needs. |
| Pure global vendor ([ADR-0005](./ADR-0005-multi-tenancy-and-global-contact-db.md)) | Rejected | Loses per-team notes/scores/outreach state + per-workspace first-reveal billing the corpus is built on. |
| Keep Typesense for the global billions-row index | Rejected | Excellent to ~100M; a billions-row shared universe with deep facets exceeds its envelope — OpenSearch is proven there. |

## Consequences

- **Positive:** a searchable universe (find-anyone → reveal); dedup once globally instead of per-workspace;
  cross-source golden values; **DSAR deletion provable** via the golden identity; reveal/credit/compliance
  machinery preserved.
- **Negative (consciously accepted):**
  - **LeadWolf is now squarely a "data broker."** CA **Delete Act / DROP** registration + deletion
    processing (from **2026-08-01**) and applicable state broker registries move from a Trust-program line
    item to a **core, GA-gating** obligation ([08 §4](../08-compliance.md#4-dsar--data-subject-access-requests),
    [08 §15](../08-compliance.md#15-trust--certification-program-adr-0014),
    [ADR-0014](./ADR-0014-trust-and-certification-program.md)). **Heaviest edits land in
    [08-compliance.md](../08-compliance.md).**
  - **More moving parts:** an ER pipeline (blocking/LSH/Splink), a golden store that shards (Citus), a lake
    (S3/Iceberg), OpenSearch + ClickHouse, and CDC into all of them.
  - **`source_records` is real lineage** at the master layer — a confidence/survivorship surface ADR-0006
    deliberately avoided. (Per-import `source_imports` stays as the overlay-side provenance.)
  - **A co-op flywheel is now possible** (workspace-imported data enriching the universe) — but it is a
    **disclosed, opt-in/contractual** privacy decision, **off by default** ([06 §1](../06-enrichment-engine.md#1-principles)).
- **Mitigation:** the master graph is **system-owned and not customer-readable** except through masked
  search + paid reveal; suppression/consent are enforced at both layers; deletion cascades golden → source →
  overlays with a verification scan; billions-scale infra (shard/lake/OpenSearch/ClickHouse) is the **scale
  path**, not all required at MVP — staged by milestone ([10](../10-roadmap.md)).

## Revisit if

The data-broker/compliance cost of operating a global universe outweighs the value of the shared asset, or a
regulated segment requires a pure per-workspace deployment — then carve that segment back to the ADR-0006
overlay-only model (the overlay still works standalone).
