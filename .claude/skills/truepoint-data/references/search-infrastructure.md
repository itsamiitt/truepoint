# Search Infrastructure

"Find all VPs of Engineering at SaaS companies with 50–200 employees in the EU
who have a verified email" — faceted search across the prospect/company dataset is
the headline capability of a sales intelligence product. At hundreds of millions
of records it cannot be served by SQL `LIKE` scans. This file is the search
architecture. The search *engine* (cluster scaling, shards) is provisioned by
`truepoint-platform`; this file is the index design, the pipeline that fills it,
and how it stays correct.

---

## Postgres Is Truth; the Index Is the Query Surface

The single most important rule, restated from the data skill's principles:

- **Postgres stores the canonical Person/Company dataset** (see `data-model.md`) —
  it is the source of truth.
- **The search surface** holds a **derived, query-optimised projection** of that
  data — the surface that answers faceted/full-text queries fast — behind a
  `SearchPort` interface so the engine can be swapped without touching callers.
- They are **never two independent sources**. The projection is rebuilt from
  Postgres; if they disagree, Postgres wins and the projection is corrected. A
  write goes to Postgres first, then propagates to the search surface — never to
  the search surface alone.

A "search" feature that queries Postgres directly with `ILIKE`/`OR` filters over
the big dataset is the failure this architecture exists to prevent (see platform
scaling-playbook tier 4). **Use an index; never SQL `LIKE`/`OR` scans at scale.**

> **Implementation status:** search runs today on Postgres behind an **in-memory
> `SearchPort` adapter** (`apps/api/src/features/search/searchPortProvider.ts`; a
> Typesense container is in the dev compose). The full
> OpenSearch (global) + Typesense (overlay) + ClickHouse (facets) index is
> **ADR-0021 future work** behind the *same* `SearchPort` interface — the
> never-`LIKE`-at-scale mandate stands and the interface is already in place so the
> swap is non-breaking.

---

## The Indexing Pipeline

Changes in Postgres propagate to the index through a pipeline, not by hoping a
background reindex catches up:

- **On write**, the change is enqueued for indexing (see platform async-jobs) —
  create/update indexes the record, delete de-indexes it. The architecture
  dependency-wiring skill's "wire the index write at creation, de-index at
  deletion" is satisfied here.
- **Change-data-capture (CDC)** or an outbox pattern is the robust mechanism for
  the large dataset — index updates derive from the committed change log, so an
  index write is never silently missed because someone forgot to call it.
- **Records are searchable promptly after they change** — near-real-time, via the
  pipeline. Background full reindex is a *recovery/migration* mechanism (rebuild
  the index from truth), not the primary path.
- **Bulk changes batch** their index writes rather than one-per-record, to keep up
  with imports and bulk enrichment without overwhelming the engine.

---

## Eventual Consistency — Design For It

The index lags Postgres by a short, variable amount (the pipeline isn't
synchronous). This is acceptable for browse/search but must be designed for:

- A record just created may not appear in search results for a moment. The UI
  shouldn't imply "it failed" — the canonical record exists in Postgres; the index
  catches up. Read-your-own-write for the *detail* view comes from Postgres, not
  the index (see platform data-platform).
- Counts from search are *approximate/eventually-consistent*; exact counts that
  matter (billing, a precise total) come from the source of truth, not the index.
- Permissions are **re-checked against truth on access** — search returns
  *candidate* IDs fast; what the user may actually open is governed by tenant
  scope and ownership/sharing at read time (see Access below).

---

## Index Design

- **Index the fields people filter and search on**, shaped for facets: title,
  seniority, function, company, industry, company size band, geography,
  technologies, verification status, and free-text name/company. Facets are the
  product — model them as filterable/aggregatable fields, not free text.
- **Denormalise for query speed**: the index document can flatten person + company
  attributes together so a single query answers "person at company with these
  company traits" without a join. The index is allowed to duplicate what Postgres
  normalises — that's its job.
- **Keep the index document lean** — only what search needs to filter, rank, and
  display in a result row. Full record detail is fetched from Postgres when the
  user opens a result (data minimisation — security data-protection).

---

## Access Control on Search

Search is not exempt from tenant isolation and visibility — it's a common place to
leak.

- **Tenant scope**: search over a tenant's working set (their Prospects) is filtered
  by `tenant_id`/`workspace_id`. Search over the shared canonical dataset
  (prospecting new people) returns canonical records, but what a workspace can
  *pull into their CRM* and the per-workspace overlay (already-added, owner, list
  membership) is tenant-scoped.
- **Visibility scope**: results a user sees within their workspace respect
  ownership/sharing (see `ownership-and-sharing.md`) — enforced by filtering the
  query and re-checking on access, never by hiding results client-side.
- The projection must carry the fields needed to apply these filters (e.g.
  `tenant_id`, `workspace_id`, `ownerUserId` on tenant-projected documents) so
  scoping happens in the query, not after.

---

## Relevance and Ranking

- Default ranking balances match quality with data quality — a result with a
  verified email and complete profile ranks above a sparse one, all else equal.
- Ranking is tunable and measurable; "good search" is judged on whether reps find
  who they're looking for, not on an internal score.
- Pagination over results uses the cursor contract (platform api-contract) — deep
  result sets page stably, and there's a sane max result window.

---

## Checklist

- Is search served from the index, with Postgres as the source of truth (never
  index-only writes, never SQL `LIKE` over the big dataset)?
- Does every Postgres change propagate to the index via a robust pipeline
  (queue/CDC/outbox), with full reindex reserved for recovery?
- Is the system designed for eventual consistency (detail/read-your-own-write from
  truth; approximate counts from the index; exact counts from truth)?
- Are tenant scope and ownership/sharing enforced in the query and re-checked on
  access — not hidden client-side?
- Is the index document lean, faceted, and denormalised for query speed, with full
  detail fetched from Postgres on open?
