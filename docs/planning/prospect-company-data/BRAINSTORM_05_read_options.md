# BRAINSTORM 05 — Read Path for the Linked Prospect+Company View: Substrate Options

> **Gate:** BRAINSTORM · **Phase:** 5 — Read Path, Search & Caching · **Depends on:**
> [RESEARCH_05_read_path.md](./RESEARCH_05_read_path.md) (the survey + the two-surface / flatten-low-churn
> recommendation this gate stress-tests), [RESEARCH_00_current_state.md](./RESEARCH_00_current_state.md) (P8: the
> global index / ClickHouse / Typesense / Redis / CDC search-sync are all **unbuilt**; only the overlay-Postgres path
> exists), [RESEARCH_01 §2 / RESEARCH_02 §2.5](./RESEARCH_02_linking_patterns.md) (`current_company_id` is a **derived
> cache** of the current edge, recomputed transactionally — the read model is *already* a denormalization the system
> must keep coherent), [RESEARCH_03 §C.3](./RESEARCH_03_mdm_merge.md) (the `field_provenance` winner is **materialized
> on write**, never recomputed at read), and [RESEARCH_04 §3.3/§3.4/§7](./RESEARCH_04_tenancy_projection.md) (the
> projection boundary: a search-index ACL is **not** the authorization boundary; masked-facet leakage; access-path
> isolation for Layer 0). **Anchors:** [ADR-0021](../decisions/ADR-0021-global-master-graph-and-overlay.md) (two-layer
> model + OpenSearch/Typesense/ClickHouse topology), [ADR-0035](../decisions/ADR-0035-search-query-and-filter-architecture.md)
> (engine stack, suggesters, facet counts, keyset+PIT), [ADR-0024](../decisions/ADR-0024-performance-slos-and-capacity-model.md)
> (SLOs + invalidate-on-write cache policy), [03 §5.1/§5.2/§9/§12](../03-database-design.md), [02 §3.1/§3.3](../02-architecture.md),
> [24 §5–§7](../24-advanced-search-exploration-ux.md), and the shipped overlay read path
> (`packages/db/src/repositories/searchRepository.ts`) + `SearchPort` contract (`packages/types/src/search.ts`).
> **Feeds:** the Phase-5 PLAN. This gate **generates and stress-tests substrate options and ends in a DECISION**; it
> writes no schema, no index mapping, no migration, and no plan.

---

## 0. What this gate decides, and against what

RESEARCH_05 *recommended* a two-surface, search-index-as-read-model design and flagged the obvious live-join default
as the thing to reject. This gate does the adversarial work the research deferred: put the three read-path
**substrates** the task names — **(A)** a **live SQL join per request** (`overlay → master_persons → master_employment
→ master_companies`), **(B)** a **precomputed hydrated projection table / materialized view** kept fresh by the
pipeline, **(C)** the **search index as the browse read-model** with Postgres reserved for detail/reveal — next to
each other, drive each into the hard cases until it breaks, **explicitly challenge the obvious live-join default**, and
resolve to one committed direction. The output is that direction plus the open questions it carries — *not* the plan.

**The decision is narrower than "how does TruePoint read."** The earlier gates already locked the *substrate the read
model is derived from*: `master_*` is the lean current-state golden projection, `current_company_id` is a derived
cache of the highest-confidence current edge (RESEARCH_02 §2.5), and the per-field winner + `field_provenance` are
materialized on write (RESEARCH_03 §C.3). This gate decides only **how the flattened "person at a company with these
traits" card is physically served on the read path, on each of the two surfaces** — and which substrate authorizes
which query. Everything here sits *on top of* the accepted write-side model; none of it re-litigates ADR-0021.

**The non-obvious framing this gate must hold.** A and B and C are **not three mutually-exclusive answers to one
question** — they are three substrates that can each apply to a *different surface and a different query class*. The
read path is not one path: it is **two surfaces × three query classes** (browse/filter list, facet counts, single-record
detail/reveal), each with its own latency, freshness, and isolation budget (RESEARCH_05 §C.1, §B.6). The error this gate
exists to prevent is **picking one substrate for the whole matrix** — which is exactly the trap that makes the live-join
default look reasonable (it works for *detail*, then is wrongly extended to *browse at billions*).

**Decision criteria.** Each substrate is scored against seven stress axes (the hard cases the task names) and five
cross-cutting constraints (the brief's read-path invariants).

| # | Stress axis | Why it is decisive |
|---|---|---|
| **S1** | **Billion-row retrieval + faceting latency** | Masked-search p95 **200 ms** at billions ([ADR-0024:22](../decisions/ADR-0024-performance-slos-and-capacity-model.md)); the substrate must return a filtered, faceted page without scanning ([24 §5](../24-advanced-search-exploration-ux.md)). |
| **S2** | **N+1 / join fan-out across the 3-hop edge** | `overlay → master_persons → master_employment → master_companies` is a 4-table join; at billions a query-time join is the cost denormalization exists to avoid (RESEARCH_05 §B.1, §D; each ES join "adds significant tax"). |
| **S3** | **Hot-company fan-out (millions of employees)** | A firmographic change on a high-degree company must re-propagate to *every* current employee doc — **Apollo's exact reindex storm** at 150k fan-out ([VERIFIED — siren.io, RESEARCH_05 §A.1](./RESEARCH_05_read_path.md)). Worse for a company with millions of employees. |
| **S4** | **Invalidation on merge / job-change / reveal / import** | The read model must converge after each write event without two sources of truth ([ADR-0024:29](../decisions/ADR-0024-performance-slos-and-capacity-model.md) invalidate-on-write; RESEARCH_05 §C.4). |
| **S5** | **Eventual consistency vs read-your-own-write** | Browse may lag < 5 s (CDC, [ADR-0024:25](../decisions/ADR-0024-performance-slos-and-capacity-model.md)); the record you **just** revealed/edited must read strong (RESEARCH_05 §B.6 Tier 2). |
| **S6** | **Per-workspace masking in a shared index** | Layer 0 is system-owned, **one shared sharded index**, isolated by **access path** not a per-workspace RLS predicate ([24 §5.2:235-242](../24-advanced-search-exploration-ux.md), RESEARCH_04 §3.3); the overlay is RLS-scoped. The substrate must keep these two isolation models separate. |
| **S7** | **Exact load-bearing counts (select-all N → credit spend)** | The "Select all N results" total that seeds a bulk reveal/export is a **credit spend**, so it must be **exact**, while browse facet counts may be approximate (RESEARCH_05 §C.3; the shipped exact-`countContacts` / capped-`resolveVisibleIds` split, `searchRepository.ts:287-325`). |

**Cross-cutting constraints (a hard fail on any one disqualifies the substrate for that surface):** **C1** — Postgres
(golden + overlay) is the **single source of truth**; every other store is a **derived projection** rebuildable from it,
never a second authority ([24 §5:192-193](../24-advanced-search-exploration-ux.md); [ADR-0002](../decisions/ADR-0002-search-postgres-then-engine.md)
amended). **C2** — **two surfaces, never conflated**: global masked search (Layer 0, access-path isolation) and overlay
browse (Layer 1, RLS), with different engines/consistency tiers (RESEARCH_05 §C.1). **C3** — **PII never leaves the
index**; search returns masked rows, the channel unmasks only inside the reveal tx ([03 §9:698](../03-database-design.md),
[02 §3.1](../02-architecture.md)). **C4** — **permission + charge re-checked at read against truth**: the index returns
candidates, Postgres (RLS + ownership + credit + suppression, in-tx, uncached) authorizes ([ADR-0024:29](../decisions/ADR-0024-performance-slos-and-capacity-model.md);
RESEARCH_04 §3.3, §7). **C5** — **no N+1, no unbounded fan-out** at 10×; reads land on replicas/index/cache, never the
primary writer ([ADR-0024:34](../decisions/ADR-0024-performance-slos-and-capacity-model.md)).

---

## 1. The candidate substrates

Three *distinct shapes* (not parameter variations). They differ on the load-bearing question: **when is the flattened
person+company card assembled — at read time (A), at write time into a Postgres table (B), or at write time into a
search document (C)** — and therefore *what pays the join cost and where freshness lag lives*.

### Substrate A — Live SQL join per request (assemble the card at read)

No materialized read model. Each browse/detail request joins the live tables and hydrates the card on the fly — on a
read replica for browse, on the primary (in-tx) for read-your-own-write.

```
  request ─▶ ONE query, joined at read time
  ┌───────────────────────────────────────────────────────────────────────────────────┐
  │ SELECT … FROM contacts c                       -- overlay (RLS: workspace_id)        │
  │   JOIN master_persons    p  ON p.id = c.master_person_id                             │
  │   LEFT JOIN master_employment e ON e.master_person_id = p.id AND e.is_current        │
  │   LEFT JOIN master_companies   co ON co.id = e.master_company_id                     │
  │ WHERE c.deleted_at IS NULL AND <facet predicates on p.* / co.* / c.*>                │
  │ ORDER BY <sort>, c.id  LIMIT n   (keyset seek)                                       │
  └───────────────────────────────────────────────────────────────────────────────────┘
  global surface: same join over master_* only (no overlay), filtered to masked columns
```

- **Strongest argument.** **Zero read-model to build, zero staleness, zero fan-out cost on write.** Truth is read
  directly, so there is *never* an invalidation problem (S4 is vacuous), *never* a read-your-own-write gap (S5 is
  vacuous — every read is strong), and a merge/job-change/reveal is visible the instant its tx commits. It is also the
  only substrate that needs **no new infrastructure** — it extends the shipped `searchRepository` join
  (`searchRepository.ts:300-325,382-403` already left-joins `accounts`) by swapping the single `account_id` FK for the
  master 3-hop. For the **overlay detail drawer** (one record, indexed FK lookups, no fan-out) it is genuinely optimal.
- **The failure mode that kills it as the *browse* default: it does not scale, exactly as the task warns.** A 4-table
  join with facet predicates on **`master_companies` traits** and a sort over **billions** of `master_persons` is the
  query-time-join cost denormalization exists to avoid — each join hop "adds significant tax" and relationship
  performance falls off fast past 2–3 levels ([VERIFIED — rockset/elastic, RESEARCH_05 §B.1](./RESEARCH_05_read_path.md)).
  Faceting (count distinct industries among the matched set) becomes a `GROUP BY` over a billion-row join — the exact
  high-cardinality aggregation Postgres/OpenSearch both strain on (RESEARCH_05 §B.2; S1/S7 fail). And the global surface
  *cannot* use it at all without re-implementing masking + access-path isolation + relevance ranking + typeahead that
  the index gives for free (S6). Apollo **moved to** a query-time join engine (Siren, 350 nodes) only to escape a *bad*
  denormalization of a *high-churn* field — not because the join is the right default ([VERIFIED — siren.io, RESEARCH_05
  §A.1, §D](./RESEARCH_05_read_path.md)). **Rejected as the browse default; retained, narrowly, for single-record
  detail hydration** (§3, §4) where its strengths (strong consistency, no fan-out) are exactly what detail needs.

### Substrate B — Precomputed hydrated projection table / materialized view (assemble the card on write, in Postgres)

A denormalized `person_card` projection table (or a Postgres materialized view), one row per master_person, carrying
the person facets **plus the flattened current-company traits**, maintained by the pipeline as the edge/firmographics
change. Read with a **single indexed lookup**, no join. (Global card is system-owned; an overlay variant carries the
workspace's per-tenant state.)

```
  WRITE side (pipeline / CDC)                      READ side (one indexed lookup, no join)
  edge change / firmographic change                ┌──────────────────────────────────────┐
  ─▶ recompute current_company_id (derived cache)   │ SELECT * FROM person_card             │
  ─▶ UPSERT person_card(master_person_id, …,         │  WHERE <facet predicates>             │
       company_industry, company_employee_band,      │  ORDER BY sort, id LIMIT n  (keyset)  │
       company_revenue_range, hq_country,            └──────────────────────────────────────┘
       has_email, has_phone, data_quality_score)     -- B-tree / partial / covering indexes
  person_card  (system-owned; NO workspace_id, NO owner)   on the flattened facet columns
```

- **Strongest argument.** **It is the flattened read model *inside the source of truth*** — one store, one technology,
  no CDC-to-a-foreign-engine lag, **strong consistency by default** (a read of the card is a Postgres read, so RYOW is
  free — S5 ✓), and it **eliminates the join** (S2 ✓) while staying trivially rebuildable from `master_*` (C1 ✓). It is
  the smallest possible step from today's overlay join: the same `searchRepository` query shape, pointed at a
  pre-joined table. For the **overlay surface (≤100M rows)** it is a clean, RLS-compatible fit — a `contact_card`
  materialization scoped by `workspace_id` reads with the existing `withTenantTx` boundary (`searchRepository.ts:259-261`).
- **The failure mode that kills it as the *global* surface: Postgres is the wrong engine for billion-row faceted
  retrieval + relevance + typeahead, and the hot-company restamp is a write-amplified fan-out.** Even pre-joined, a
  filtered+faceted+ranked scan over **billions** of `person_card` rows is not a 200 ms p95 query — Postgres has no
  sharded inverted index, no completion/edge-ngram suggester, no `synonym_graph` (CEO⇄Chief Executive Officer), and its
  high-cardinality `GROUP BY` facet counts are the load ClickHouse exists to absorb ([ADR-0035:46,68](../decisions/ADR-0035-search-query-and-filter-architecture.md),
  RESEARCH_05 §B.2; S1/S7 strain). And the **hot-company fan-out (S3) bites here too**: a firmographic change on a
  company with millions of current employees must `UPDATE person_card` for *every* one of them — a write-amplified
  restamp on the hottest table, the Apollo wound relocated from the index into Postgres ([VERIFIED — siren.io,
  RESEARCH_05 §A.1](./RESEARCH_05_read_path.md)). A **Postgres MV is worse** (no incremental refresh; `REFRESH
  MATERIALIZED VIEW` re-scans the base relations — unusable at billions). **Rejected as the global billion-row browse
  surface; strong as the overlay (≤100M) substrate and as the *source projection that feeds C* (§3).**

### Substrate C — Search index as the browse read-model (assemble the card on write, into a search doc)

The flattened card is a **denormalized search document** in OpenSearch (global, billions) / Typesense (overlay, ≤100M),
fed by CDC, with **ClickHouse** for exact counts and **Redis** for cached counts; Postgres is read only for **detail,
reveal, RYOW, and every money/permission decision**. This is RESEARCH_05's recommendation, here as a candidate to break.

```
  Postgres (truth) ──logical replication / CDC──▶ search-sync worker ──▶ OpenSearch (global, masked doc)
        │ (02 §3.3:162-171)                            │ (24 §5:192-193)  ──▶ Typesense (overlay collection/ws)
        │                                              └──▶ ClickHouse (LowCardinality facet MVs, EXACT counts)
        │                                                    Redis (facet-count cache, short TTL + single-flight)
        ▼ detail / reveal / RYOW / credit / suppression (in-tx, uncached — C3/C4)
  global doc:  {person facets, current_company traits, has_email/has_phone, NO PII, NO workspace_id, NO owner}
  browse ─▶ OpenSearch query (one lookup, no join) ─▶ masked candidate IDs ─▶ Postgres authorizes the open/reveal
```

- **Strongest argument.** **It is the only substrate that meets the billion-row latency SLO *and* the global-masking
  model at once.** A sharded inverted index answers "person at a company with these traits" as **one lookup over a
  pre-joined doc** (S1/S2 ✓), `search_after`+PIT gives constant-cost paging ([24 §6:258-266](../24-advanced-search-exploration-ux.md);
  S1 ✓), ClickHouse MVs give **exact** load-bearing counts at billions while OpenSearch aggs serve approximate browse
  counts (S7 ✓), and the **shared, sharded, masked doc is isolated by access path** — it carries no `workspace_id`/owner,
  so there is no per-tenant ACL to go stale and **the field that broke Apollo is architecturally absent** (S3/S6 ✓,
  RESEARCH_05 §C.1-§C.2). It is the already-chosen topology ([ADR-0021:72-77](../decisions/ADR-0021-global-master-graph-and-overlay.md),
  [ADR-0035:25-29](../decisions/ADR-0035-search-query-and-filter-architecture.md)).
- **The failure mode that *threatens* it: it is eventually consistent and it is a second store to keep coherent.** A
  CDC-fed index lags writes (< 5 s SLO, [ADR-0024:25](../decisions/ADR-0024-performance-slos-and-capacity-model.md)),
  so RYOW *cannot* come from it (S5 — must route to Postgres), a dropped CDC event silently diverges the projection
  until a reconcile catches it (S4 risk), and a job-change that is *not* recomputed coherently with the edge serves
  "person at the wrong company" — the most expensive correctness bug (RESEARCH_02 §4). It also **cannot be the
  authority** on who-may-open a record: an index-side ACL is a stale pre-filter, never the boundary (RESEARCH_04 §3.3,
  C4). These are **operational/correctness disciplines, not disqualifiers** — each has a named mitigation (§2). The one
  place C *fails outright* is the queries it must **not** serve: detail/reveal/RYOW/credit/suppression, which are C's
  own "read from Postgres" carve-out, i.e. **C is not a complete read path on its own** — it needs A (detail) underneath.

---

## 2. Stress-test matrix

Scoring per surface where it matters: **✓** survives cleanly · **~** survives only with the noted engineering · **✗**
fails the axis.

| Axis | A (live join) | B (Postgres projection / MV) | C (search-index read-model) |
|---|---|---|---|
| **S1** billion-row retrieval + faceting | ✗ 4-table join + `GROUP BY` over billions; no 200 ms p95 | ✗ global: no inverted index/suggester; ~ overlay ≤100M | ✓ sharded inverted index + ClickHouse exact counts |
| **S2** N+1 / 3-hop join fan-out | ✗ pays the join every request | ✓ pre-joined, single lookup | ✓ pre-joined doc, single lookup |
| **S3** hot-company fan-out (millions of employees) | ✓ no write fan-out (join at read) | ✗ `UPDATE person_card` for every employee = write-amp restamp | ~ bounded CDC `_bulk` re-index of *current* employees; **owner/score not in doc** so the worst field never fans out |
| **S4** invalidation (merge/job-change/reveal/import) | ✓ vacuous — reads truth | ~ in-tx UPSERT on write; MV refresh is non-incremental ✗ | ~ event-driven CDC + TTL safety net + reconcile (C's discipline) |
| **S5** eventual consistency vs RYOW | ✓ every read strong | ✓ Postgres read = strong | ~ browse lags < 5 s; **RYOW + detail must route to Postgres (A)** |
| **S6** per-workspace masking in shared index | ✗ global needs hand-rolled masking/relevance/typeahead | ✗ global same; ~ overlay RLS-clean | ✓ masked doc, no `workspace_id`, access-path isolation; overlay = Typesense collection-per-ws |
| **S7** exact load-bearing count (select-all N) | ~ exact but a billion-row join `COUNT` | ~ exact but a billion-row `COUNT` | ✓ ClickHouse MV exact + capped `resolveVisibleIds` mutation footprint |
| **C1/C4** truth = Postgres / perm re-checked | ✓ *is* truth | ✓ *is* truth | ✓ iff index = candidates, Postgres authorizes |

Read down the columns: **A fails the two scale axes (S1, S2) and the global-masking axis (S6) but wins every
consistency axis (S4, S5) — it is strong exactly where browse is weak and weak exactly where browse is hard.** **B
eliminates the join (S2) and reads strong (S5) but is the wrong engine at billions (S1/S6) and re-creates the
hot-company restamp inside Postgres (S3).** **C wins every scale/masking axis (S1, S2, S6, S7) and bounds the fan-out
(S3) but is eventually consistent (S5) and is not a complete path alone (needs A for detail/RYOW).** **A and C fail
opposite axes** — A is strong where C is "~" (consistency) and weak where C is strong (scale/masking). That
complementarity is the whole decision (§3, §4): the surfaces and query-classes that A serves well are precisely the
ones C carves out to Postgres, and vice-versa.

### The decisive cases, in prose

**S1/S2 — scale (the gate that eliminates A and global-B).** "Person at a company with these company traits" over
**billions** is the initiative's headline query (RESEARCH_02 §2.5). A pays a 4-table join + high-cardinality facet
`GROUP BY` *per request*; global-B pays the same `GROUP BY` over a pre-joined table with no inverted index, no
suggester, no `synonym_graph`. Only a sharded inverted index with ClickHouse exact counts holds the 200 ms p95 at this
cardinality ([ADR-0024:22](../decisions/ADR-0024-performance-slos-and-capacity-model.md), [ADR-0035:46,68](../decisions/ADR-0035-search-query-and-filter-architecture.md),
RESEARCH_05 §B.2). This is not a tuning gap — it is an engine-class mismatch.

**S3 — hot-company fan-out (where B is *worse* than C, and C's structural fix matters).** A company with millions of
current employees is the worst case the task names. Under **A** there is no write fan-out at all (the company traits are
joined at read) — A's one real win on the scale axes. Under **B**, a single firmographic change (`employee_band`,
`industry`) must `UPDATE person_card` for **every** employee — a write-amplified restamp on the hottest table; under a
naïve denormalization that *also* carried per-tenant `owner`/`score`, a high-churn owner change would trigger it
constantly: **Apollo's exact wound** ([VERIFIED — siren.io: "millions of reindex operations … incorrect results,
missing data", RESEARCH_05 §A.1](./RESEARCH_05_read_path.md)). Under **C** the restamp is the *same* fan-out but
**(i)** firmographics are **low-churn** so it fires rarely, **(ii)** it runs as **coalesced `_bulk` CDC re-index of the
company's current employees only** ([24 §5.1:221-225](../24-advanced-search-exploration-ux.md)), and **(iii)** the
**per-tenant volatile field that made Apollo's storm continuous is architecturally absent from the global doc**
(RESEARCH_05 §C.2). So S3 is not "C avoids fan-out" — it is "C bounds an unavoidable, rare fan-out and removes the
field that would make it constant," whereas B makes the *same* fan-out a synchronous write-amplification on the OLTP
primary. **This is the crux that beats B at the global surface.**

**S4 — invalidation (where A is vacuous and the choice is about *which* lag is acceptable).** A has no invalidation
problem because it reads truth — genuinely its strongest property, and the reason it is retained for detail. B's
"invalidation" is an in-tx UPSERT (cheap for the single edited card, expensive for the hot-company restamp, S3); a
Postgres MV's refresh is non-incremental and unusable at billions. C's invalidation is the event-driven CDC re-index
keyed by doc id (idempotent, last-write-wins on the projection is correct — one writer, the search-sync worker;
RESEARCH_05 §C.6.2) with a **TTL safety net + periodic reconcile** catching dropped events, and the money/permission
caches **exempt** (read in-tx, [02 §3.1:104-111](../02-architecture.md)). The merge/job-change/reveal/import event→cache
mapping is already enumerated (RESEARCH_05 §C.4) and is a PLAN concern, not a substrate differentiator — *any* derived
substrate (B or C) needs it; only A escapes it, at the cost of S1.

**S5 — eventual consistency vs RYOW (the axis that forces the composite).** This axis alone proves no single substrate
suffices. Browse over billions **must** be eventually consistent (C, < 5 s) — you cannot read-your-own-write a global
index synchronously at that scale. But the contact you **just** revealed or edited **must** read strong — which is a
Postgres read (A), because the reveal tx committed there ([02 §3.1:103-114](../02-architecture.md)). The CQRS answer is
exactly this split: route the writer's immediate read to the write store, show a pending/"indexing N rows" indicator
otherwise ([VERIFIED — Azure CQRS, RESEARCH_05 §A.3, §B.6](./RESEARCH_05_read_path.md); [24 §5.1:226-228](../24-advanced-search-exploration-ux.md)).
**S5 is not won by a substrate — it is won by assigning each query class to the right substrate.**

**S6 — per-workspace masking in a shared index (the axis that eliminates A and B for the *global* surface).** Layer 0
is **one shared sharded index**, system-owned, isolated by **access path**, not a per-workspace RLS predicate
([24 §5.2:235-242](../24-advanced-search-exploration-ux.md), RESEARCH_04 §3.3). C delivers this natively: the doc is
masked + PII-free + carries no `workspace_id`/owner, so there is no per-tenant ACL to maintain or leak, and isolation is
the masked schema itself (the index *is* the privacy boundary, RESEARCH_04 §4.1). A and B would each have to re-implement
masking, relevance ranking, suggesters, and access-path gating over the raw tables — re-building what the index gives
for free, and risking exactly the **facet/aggregate leakage** RESEARCH_04 §3.4 warns of (a masked count can leak the
existence of records the user can't reveal). For the **overlay** surface, by contrast, RLS *is* the wall and A/B are
both clean — the masking concern is specific to the shared global index.

**S7 — exact load-bearing counts (the correctness rule, not a perf choice).** Browse facet counts ("~12,400 in SaaS")
may be approximate (OpenSearch shard-local-top-N, `doc_count_error_upper_bound`) because the user is exploring. The
**"Select all N" total that seeds a bulk reveal/export is a credit spend** and must be **exact** — ClickHouse MV at
billions, mirroring today's exact-uncapped `countContacts` (`searchRepository.ts:287-306`) vs capped `resolveVisibleIds`
(`searchRepository.ts:308-325`) split (RESEARCH_05 §C.3). A and B can produce an exact count but only as a billion-row
`COUNT` over a join/table — slow and primary-loading; C routes it to the columnar store built for it. The capped
mutation footprint (`BULK_SELECTION_CAP`) is a *separate* safety the PLAN keeps regardless of substrate.

---

## 3. Challenging the obvious choice — is the live join (A) actually fine, and where does C genuinely lose?

The task names A — "live SQL join per request" — as **the obvious default to challenge**. The gate must try to make it
stick before rejecting it, and try to break C before adopting it. Five honest challenges, both directions.

1. **A's appeal is real and is *consistency*, not just simplicity.** "Just join the live tables" is seductive because
   it makes S4 and S5 vanish — no invalidation, no staleness, no second store, no CDC worker, no reconcile job. For a
   team shipping the *overlay detail drawer* (open one contact: indexed FK lookups, no fan-out, must read strong) A is
   not merely acceptable — it is **optimal**, and the honest conclusion is to **keep A there**. The challenge is whether
   that local optimality generalizes to *browse at billions*. It does not: S1/S2/S6 are an engine-class wall, not a
   tuning gap. **A is right for one query class (detail) and catastrophically wrong for another (global browse)** — so
   "A as the read path" is the error; "A as the detail substrate" is correct.

2. **The "just put it on a read replica" rescue of A fails at billions.** One could argue A scales by reading from
   Aurora replicas ([ADR-0024:34](../decisions/ADR-0024-performance-slos-and-capacity-model.md)) instead of the
   primary. Replicas solve *write contention*, not *query cost*: a 4-table join with high-cardinality facet `GROUP BY`
   and relevance ranking over billions is the same expensive query whether it runs on a primary or a replica, and
   replicas still lack the inverted index, suggester, and `synonym_graph` the UX requires ([ADR-0035:36-44](../decisions/ADR-0035-search-query-and-filter-architecture.md)).
   Replicas extend A's reach for the *overlay* (≤100M), not for the *global billions* surface.

3. **The strongest case *against* C is the second-store tax — and it is real but already paid.** C adds a CDC worker, a
   reconcile job, freshness monitoring, and an "indexing N rows" honesty indicator — operational surface A avoids
   entirely. But this tax is **already accepted**: the topology is locked ([ADR-0021:72-77](../decisions/ADR-0021-global-master-graph-and-overlay.md),
   [ADR-0035:25-29](../decisions/ADR-0035-search-query-and-filter-architecture.md)), CDC search-sync is already the
   architecture ([02 §3.3:162-171](../02-architecture.md), [24 §5:192-193](../24-advanced-search-exploration-ux.md)),
   and the whole derived model is **rebuildable from Postgres** (C1), so the failure mode of the tax (divergence) is
   recoverable by re-running search-sync — not a data-loss class. The tax buys the only thing that meets S1/S6 at
   billions. It is justified.

4. **B is the genuine dark-horse — and it is not rejected, it is *relocated*.** B's idea — "pre-join the card on write,
   read it with one lookup" — is **correct**, and it is exactly what C does *into a search doc* and what the overlay
   does *into Postgres*. The honest framing is that **B and C are not competitors at the global surface; B is the
   projection that *feeds* C**. The flattened card is materialized once (B-mechanism) from the edge + firmographics +
   provenance winner, then **fanned to the search index (C, for browse/filter/facet)**. At the **overlay** surface
   (≤100M, RLS-scoped), a Postgres-resident B projection (`contact_card`) or even A on a replica is a legitimate
   *complete* answer — Typesense is the scale-out option, not a requirement at overlay cardinality. So B wins the
   overlay and loses the *global billions* surface only because Postgres is the wrong *retrieval engine* there, not
   because the *pre-join-on-write idea* is wrong. **B's idea survives everywhere; B-as-Postgres-billions-retrieval does
   not.**

5. **The opposite over-reach — "then drop A entirely, serve everything from the index" — also fails.** If C tried to
   serve detail/reveal/RYOW, it would (a) violate C3 (the index is masked/PII-free — it *cannot* return the revealed
   email), (b) violate C4 (an eventually-consistent index ACL is not the authority — RESEARCH_04 §3.3), and (c) break
   S5 (the just-revealed cell would lag its own write). So C **structurally requires** a Postgres read underneath for
   exactly the query classes A is best at. **You keep A precisely where C carves out — detail, reveal, RYOW, and every
   money/permission decision — and you use C for browse over the shared masked index.** That is the synthesis.

The conclusion the challenges converge on: **this is not "A vs B vs C" — it is a surface-and-query-class assignment.**
The live-join default is wrong *as a blanket read path* and right *as the detail substrate*; the index is right *for
browse at billions* and wrong *for detail/RYOW*; the Postgres pre-join is right *for the overlay and as C's feed* and
wrong *as the global retrieval engine*.

---

## 4. DECISION

**Adopt a surface-and-query-class composite: serve global browse from the search index (C) over a flattened, masked,
low-churn golden doc; serve overlay browse from the overlay read model (B-in-Postgres today / Typesense at scale,
RLS-scoped); and serve every single-record detail, reveal, read-your-own-write, and money/permission decision from a
live Postgres read (A) against truth. Reject the live join (A) as the browse default; reject the Postgres projection /
MV (B) as the global billion-row retrieval engine; retain B's pre-join-on-write idea as the projection that *feeds* C
and as the overlay substrate; retain A only for detail/RYOW.** Concretely, the single direction that proceeds to the
PLAN is six committed parts:

1. **Two surfaces, three query classes, mapped to substrates (the routing table).** This is the artifact the PLAN
   builds against — every read names its surface, class, substrate, engine, and consistency tier:

   | Surface | Query class | Substrate | Engine | Consistency |
   |---|---|---|---|---|
   | **Global (Layer 0, access-path)** | browse / filter / typeahead | **C** flattened masked doc | OpenSearch | Tier 3 eventual (< 5 s) |
   | **Global** | facet counts (browse) | **C** | OpenSearch terms aggs (approx) | Tier 3 |
   | **Global** | **select-all N total** (credit spend) | **C** | **ClickHouse MV (exact)** | Tier 3, exact |
   | **Global** | record detail / **reveal** | **A** live Postgres read (in-tx) | Postgres | **Tier 1 strong** |
   | **Overlay (Layer 1, RLS)** | browse / filter / facet | **B** projection (Postgres ≤100M → Typesense at scale) | Postgres / Typesense | Tier 2/3 |
   | **Overlay** | detail / **just-mutated row (RYOW)** | **A** live Postgres read | Postgres | **Tier 2 strong** |
   | **Any** | credit balance / suppression / permission | **A** in-tx, **uncached** | Postgres | **Tier 1 strong, never cached** |

2. **The global browse doc is a flattened, masked, low-churn projection (C over a B-style feed).** Person identity
   facets + channel-presence booleans (`has_email`/`has_phone`, [03:418-419](../03-database-design.md)) + **current-company
   firmographics via the `current_company_id` derived cache** ([03:413](../03-database-design.md)) in **one doc, no
   query-time join**. **Explicitly excluded** from the global doc: per-tenant `owner`/`assignment`/`score`/`outreach_status`/
   `list` membership ([03 §5.2:503-505](../03-database-design.md)) — that is the structural fix for Apollo's reindex
   storm (S3). The company traits are recomputed from the new current edge **in the same CDC propagation** that closes
   the old `master_employment` edge and opens the new (RESEARCH_02 §2.5) — never hand-set, or the grid serves "person at
   the wrong company" (the most expensive correctness bug, RESEARCH_02 §4).

3. **The live join (A) is rejected as the browse default and retained for detail/RYOW.** A 4-table
   `contacts ⨝ master_persons ⨝ master_employment ⨝ master_companies` with facet `GROUP BY` over billions fails the 200 ms
   p95 (S1/S2) and cannot serve the masked global surface (S6). But the **single-record detail/reveal read** (one master
   identity, indexed FK lookups, no fan-out) and the **just-mutated overlay row (RYOW)** are exactly where A's strong
   consistency and zero fan-out are optimal — the index *cannot* serve them (masked/PII-free, eventually consistent).
   This is C's own "detail + RYOW from Postgres" carve-out (RESEARCH_05 §B.6, §C.1) made explicit as the *retained role*
   for A.

4. **B's pre-join-on-write idea is the projection that feeds C, and the overlay substrate — not the global retrieval
   engine.** The flattened card is materialized once on write (the B mechanism) and **fanned to the search index** for
   global browse (C); a Postgres MV at billions is rejected (non-incremental `REFRESH`, unusable). For the **overlay
   (≤100M)** a Postgres-resident projection (or live join on a replica) is a legitimate complete answer today; Typesense
   collection-per-workspace is the scale-out option, isolated by RLS + per-collection blast radius
   ([24 §5.2:235-242](../24-advanced-search-exploration-ux.md)), not a day-one requirement. The hot-company restamp
   (S3) is therefore a **bounded, coalesced `_bulk` CDC re-index of the company's *current* employees only**, never a
   synchronous `UPDATE person_card` storm on the OLTP primary.

5. **Exact where money/action depends on it; approximate where browsing; nothing cached on a money/permission path.**
   OpenSearch terms-agg approximation serves the exploration filter rail; the **"Select all N" total is exact from a
   ClickHouse MV** because N is a credit spend (S7), extending the shipped exact-`countContacts` / capped-`resolveVisibleIds`
   split to billions (`searchRepository.ts:287-325`). Facet counts are Redis-cached with a short per-facet TTL guarded
   by **single-flight + jitter** for hot keys at ≥5,000 concurrent/workspace ([ADR-0024:27,29](../decisions/ADR-0024-performance-slos-and-capacity-model.md),
   RESEARCH_05 §B.4). The **credit balance and the suppression/DNC gate are read in-tx with `FOR UPDATE` /
   `assertNotSuppressed`, never from a cache or the index** ([02 §3.1:104-111](../02-architecture.md)) — "no unbounded
   staleness on money/permission paths" ([ADR-0024:29](../decisions/ADR-0024-performance-slos-and-capacity-model.md)).

6. **The index returns candidates; Postgres truth authorizes (security has final say).** Global browse returns **masked
   candidate IDs** isolated by access path (no `workspace_id`/owner on the doc — nothing to leak cross-tenant); the
   overlay read is **RLS-bounded** (`withTenantTx`, `searchRepository.ts:259-261`) with owner/team visibility re-applied
   app-layer; an index-side ACL (if any future overlay adapter adds one) is a **pre-filter, never the authority** — the
   open/reveal is re-checked against Postgres truth ([VERIFIED — Azure AI Search DLS, RESEARCH_05 §B.5](./RESEARCH_05_read_path.md);
   RESEARCH_04 §3.3, §7). Masked **facet/aggregate leakage** is a first-class threat: suppressed/opted-out identities are
   excluded from the global projection so they are not even *findable* (RESEARCH_04 §3.4, §4.1), and view caps + rate
   limits bound aggregate inference.

**Pagination, everywhere, is keyset.** `search_after` + PIT on the global index ([24 §6:258-266](../24-advanced-search-exploration-ux.md)),
the already-keyset overlay cursor on Postgres (`searchRepository.ts:376-403`; `contactQuery.cursor`,
`packages/types/src/search.ts:151-159`), bounded by `limit ≤ 200` (`search.ts:157`) — **never `from`/`offset`** (O(offset)
+ skip/dupe under concurrent writes, RESEARCH_05 §B.3). The whole composite hides behind the existing **`SearchPort`**
(`packages/types/src/search.ts:192-197`) so a bad adapter swaps with no caller change ([ADR-0035:83](../decisions/ADR-0035-search-query-and-filter-architecture.md)).

**Explicitly rejected.**
- **Live join (A) as the *browse* read path** — fails S1/S2 (4-table join + high-card faceting over billions, no 200 ms
  p95) and S6 (cannot serve the masked global surface without re-building masking/relevance/typeahead); Apollo *adopted*
  a query-time join engine only to escape a *bad* high-churn denormalization, not as the right default ([VERIFIED —
  siren.io, RESEARCH_05 §A.1, §D](./RESEARCH_05_read_path.md)). *Retained only for detail/RYOW.*
- **Postgres projection table / MV (B) as the *global billions* retrieval engine** — fails S1 (no inverted index/suggester/
  `synonym_graph`; high-card `GROUP BY` is ClickHouse's job) and S3 (a firmographic change `UPDATE`s every employee card
  — write-amplified restamp on the OLTP primary, the Apollo wound relocated into Postgres). A Postgres **MV is doubly
  rejected** (non-incremental `REFRESH`). *B's pre-join idea retained as C's feed + the overlay substrate.*
- **Flattening per-tenant volatile state (owner/assignment/score) onto the global doc** — the **exact Apollo failure**
  ([VERIFIED — siren.io: "millions of reindex operations … incorrect results, missing data"](./RESEARCH_05_read_path.md));
  per-tenant state stays on the overlay surface only.
- **OpenSearch terms aggs for *load-bearing* counts** — shard-local-top-N approximate; an approximate select-all-N
  mis-charges a bulk reveal (S7). Exact counts come from ClickHouse MVs ([ADR-0035:85](../decisions/ADR-0035-search-query-and-filter-architecture.md)).
- **Serving detail/reveal/RYOW or any permission decision from the index** — violates C3 (masked/PII-free — cannot
  return the revealed channel), C4 (eventually-consistent ACL is not the authority), and S5 (lags its own write).
- **Caching the credit balance, the suppression/DNC gate, or any permission decision** — read in-tx, never cached
  ([ADR-0024:29](../decisions/ADR-0024-performance-slos-and-capacity-model.md), [02 §3.1:104-111](../02-architecture.md)).
- **A second, divergent source of truth** — the index/projection are CDC-derived, rebuildable from Postgres
  ([24 §5:192-193](../24-advanced-search-exploration-ux.md)); never two independent authorities (C1).

### Open questions carried to the PLAN

- **OQ1 — global doc field list + mapping (the load-bearing one).** The exact flattened field set (person facets +
  channel booleans + which `master_companies` firmographics) and their OpenSearch types/analyzers, plus the
  `canonical_title_id` index-time normalization ([ADR-0035:39-42](../decisions/ADR-0035-search-query-and-filter-architecture.md)).
  Which fields are facet-only vs full-text vs both? (Bounds doc size — keep it lean.)
- **OQ2 — overlay substrate cutover threshold.** At what workspace cardinality does the overlay move from Postgres
  projection / live-join-on-replica (B/A) to Typesense collection-per-workspace? Is Typesense day-one, or deferred until
  a workspace's overlay exceeds a stated row/latency bound? (Ties to RESEARCH_04 §5.2 collection strategy.)
- **OQ3 — CDC propagation + hot-company restamp bound.** What caps the fan-out when a firmographic changes on a company
  with millions of current employees — coalescing window, `_bulk` batch size, `refresh_interval` relaxation, and the
  backpressure trip + "indexing N rows" indicator ([24 §5.1:221-228](../24-advanced-search-exploration-ux.md))? Is the
  job-change edge-recompute → company-trait re-index one CDC event or two, and how is ordering guaranteed (the
  "person at the wrong company" hazard)?
- **OQ4 — ClickHouse MV set + exact-count contract.** Which facet count MVs exist (industry/title-canonical/seniority/
  country/…), and is the select-all-N exact total a single MV read or an aggregation? How does the exact count stay
  coherent with the OpenSearch result set the user filtered (two engines, one truth)?
- **OQ5 — Redis facet-count key/TTL/stampede policy.** Key shape (per-query-shape vs per-facet), TTL value(s),
  single-flight lock token + jitter parameters, and the per-tenant quota so a hot workspace cannot starve the cache
  ([ADR-0024:27](../decisions/ADR-0024-performance-slos-and-capacity-model.md)).
- **OQ6 — RYOW routing mechanism.** How does the API know to route a read to Postgres vs the index — a per-session
  "recently wrote" marker, a short read-pinning window, or always-Postgres-for-detail? Where exactly is the boundary
  between "browse list" (index) and "the row I just touched" (Postgres)?
- **OQ7 — reconcile + divergence detection.** The TTL safety net catches a dropped CDC event eventually; what is the
  periodic full-reconcile cadence, and how is index↔Postgres divergence *detected* (checksum sampling, row-count
  drift)? (The C1 "rebuildable from truth" guarantee needs an operable trigger.)
- **OQ8 — `SearchPort` adapter seams.** The contract spans OpenSearch (global), Typesense (overlay), and ClickHouse
  (counts) behind one `SearchPort` (`packages/types/src/search.ts:192-197`); the only shipped adapter is the in-memory
  dev one (`packages/search/src/index.ts:1-6`). Is `facetCounts()` one method routing to ClickHouse-or-OpenSearch by
  surface, or split? (Owned jointly with the PLAN's adapter spec.)

**Implementation status (gap → work-to-do, never license to skip a rule).** Today **only the Layer-1 overlay-Postgres
read path (Substrate A/B hybrid) is built**: `searchRepository` does workspace-RLS-scoped ILIKE search + keyset paging +
GROUP-BY facet counts + ILIKE typeahead, all inside `withTenantTx` so RLS is the hard boundary
(`searchRepository.ts:1-15,259-261,327-372`), and the only shipped `SearchPort` adapter is the **in-memory dev adapter**
(`packages/search/src/index.ts:1-6`). The **global OpenSearch masked doc, the ClickHouse exact-count MVs, the Typesense
overlay collections, the Redis facet-count cache, the CDC search-sync worker, and the flattened golden read doc are all
unbuilt** (RESEARCH_00 §7.1 P8) — designed in [ADR-0021:72-77](../decisions/ADR-0021-global-master-graph-and-overlay.md),
[ADR-0035](../decisions/ADR-0035-search-query-and-filter-architecture.md), [03 §12:744-753](../03-database-design.md),
and [02 §3.3](../02-architecture.md), but with no code. Today's overlay join even uses the **degenerate single
`account_id` FK** (`searchRepository.ts:303,320,386`), not the master 3-hop edge — the link Phase 2 replaces. None of
these gaps relaxes a constraint: when built, the global doc stays **masked + PII-free + workspace_id-free** (isolated by
access path, S6/C3), the overlay read stays **RLS-FORCED + owner-scoped** (C4), the credit/suppression checks stay
**in-tx and uncached** (C4), exact load-bearing counts stay **exact** (S7), and the index stays a **derived projection
of Postgres truth**, never a second authority (C1). The PLAN gate turns this DECISION into the concrete artifacts: the
global-doc field list + OpenSearch mapping (OQ1), the search-sync CDC worker + restamp-fan-out bound (OQ3), the
ClickHouse MV set + exact-count contract (OQ4), the Redis key/TTL/stampede policy (OQ5), the RYOW routing rule (OQ6),
and the `SearchPort` OpenSearch/Typesense/ClickHouse adapter seams (OQ8).
