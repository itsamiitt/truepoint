# CASCADE Relationship Graph — Overview & Reading Order

This package extends the existing CASCADE person-layer and technology-layer schemas so that **people, companies, technologies, and schools connect through explicit, typed, directional relationships** — and never collapse into one ambiguous "connection."

It is written for an AI agent (or engineer) to build from. Read the files in order; each is self-contained but assumes the ones before it.

Provenance convention, as in the existing docs: plain prose restates decisions already made in the person/technology docs; **[NEW]** marks what this package adds.

---

## 0. The problem, stated with your example

You want the database to represent, cleanly and queryably, this web of facts:

```
Alex        —— works at ——▶            Sage
Siya        —— works at ——▶            Sage
Alex        —— studied at ——▶          SPPU
Siya        —— studied at ——▶          DPU
Sage        —— developed ——▶           Sage Intacct, Sage 50, Sage X3
Sage        —— uses ——▶                WordPress, Google Analytics, Google Keyword Planner
Google      —— developed ——▶           Google Analytics, Google Keyword Planner
```

Every arrow above is a **different kind of relationship**, and the value of the database is that a query can follow one kind of arrow without accidentally following another. "What did Sage *build*?" must return Sage Intacct / Sage 50 / Sage X3 and **not** WordPress. "What does Sage *run*?" must return WordPress / GA / Keyword Planner and **not** its own products. "Who else works where Alex works?" must return Siya. These are three different graph traversals, and the schema has to keep them separate.

## 1. The one flaw in the current schema this fixes

The existing person doc models `company_technologies(company_id, skill_id, …)` — a company's **usage** of a technology (technographics). It has **no way to say a company *created* a technology.** So in the current schema:

- "Sage uses WordPress" → a `company_technologies` row. ✅
- "Sage developed Sage Intacct" → **nowhere to put it**, or worse, the same `company_technologies` table, which would then wrongly answer "Sage uses Sage Intacct" and "Sage uses WordPress" identically. ❌

The technology doc partially anticipated this with a `technology_vendors` table (creator / current_owner / former_owner). **This package unifies both sides** into one coherent relationship model so that *usage* and *creation* and *ownership* are distinct, typed edges over the same technology catalog — and extends the same pattern to schools, people, and companies.

## 2. The core design decision: one edge table per relationship *domain*, not one giant edge table

There are two extremes, both wrong:

- **One universal `edges(from, to, type)` table** — flexible but untyped; you lose foreign-key integrity (a polymorphic endpoint cannot declare a real FK), every query is a string-match on `type`, and "person→company" and "technology→vendor" share nothing but shape. In relational terms this is the EAV / polymorphic-association anti-pattern — legitimate only when the relationship set is unknowable at design time, which a people/company/school/technology graph is not ([Karwin, *SQL Antipatterns*](https://www.oreilly.com/library/view/sql-antipatterns/9781680500073/f_0037.html)). Even the systems that *do* run one big edge store only work because type is baked into every key: Facebook's TAO keys every association read by `(id1, type)` and rebuilds inverse-edge integrity by hand ([TAO, Facebook Eng.](https://engineering.fb.com/2013/06/25/core-infra/tao-the-power-of-the-graph/)), and Neo4j's own modeling guidance is *specific relationship types, never a generic edge with a type property* — a measured ~50% db-hit reduction ([Neo4j Developer Blog](https://medium.com/neo4j/cypher-optimization-names-relationship-types-bc65e6f81f53)).
- **A bespoke table for every arrow** — `person_employment`, `person_education`, `company_develops_technology`, `company_uses_technology`, `technology_ownership`, … — maximum integrity but tables multiply. Neo4j documents the same failure at the type level: a hard 65,536 relationship-type ceiling and "significantly more convoluted" updates when every variant gets its own type ([Neo4j KB](https://neo4j.com/developer/kb/explanation-of-error-record-id-65536-is-out-of-range/)).

**[NEW] The chosen middle:** a small set of **domain-specific relationship tables**, each with a real FK on both endpoints and a `relationship_type` enum for the variants *within* that domain. Concretely:

| Relationship domain | Table | Endpoints | Type variants |
|---|---|---|---|
| Person ↔ Organization (work) | `person_positions` *(exists, extended)* | person → company | employee, founder, board_member, advisor, contractor |
| Person ↔ Organization (study) | `person_educations` *(exists, upgraded to FK)* | person → org(school) | student (alumnus is derived from dates — 02 §4) |
| Organization ↔ Technology | `org_technology_relations` **[NEW]** | company → technology | **develops**, **uses**, resells — removal of a usage fact is a *closed row*, not a type (03 §2) |
| Technology ↔ Organization (vendor) | `technology_vendors` *(exists)* | technology → company | creator, current_owner, former_owner |
| Organization ↔ Organization | `company_edges` *(exists)* | company → company | supplies, buys_from, parent_of, competitor |

The insight that makes this clean: **schools are organizations.** Sage and SPPU are both rows in one `organizations` table (with a `kind` discriminator), so "works at" and "studied at" are two relationship types over the *same* person→org substrate, not two disconnected subsystems. This is file `02`.

And **"develops" vs "uses" are two relationship types over the same company→technology substrate** — the single most important fix, in file `03`.

## 3. What each file contains

| File | Purpose |
|---|---|
| [`00-overview.md`](00-overview.md) | This file — the problem, the design decision, the map |
| [`01-entity-model.md`](01-entity-model.md) | The full entity-relationship model as a diagram + narrative; the five relationship domains and how they compose |
| [`schema/02-organizations-and-people.md`](schema/02-organizations-and-people.md) | DDL: unified `organizations` (companies + schools), `persons`, and the person→org relationships (work + study) |
| [`schema/03-technology-relationships.md`](schema/03-technology-relationships.md) | DDL: `technologies` catalog, `org_technology_relations` (develops/uses/…), `technology_vendors`, and the develops-vs-uses fix in full |
| [`schema/04-shared-provenance.md`](schema/04-shared-provenance.md) | DDL: the columns every relationship row shares — source, confidence, bitemporal validity, attestations — and why |
| [`guides/05-query-cookbook.md`](guides/05-query-cookbook.md) | Every query from your example, written out: "what did Sage build," "who works with Alex," "what does Sage run and who made it," multi-hop traversals |
| [`guides/06-ingestion-and-resolution.md`](guides/06-ingestion-and-resolution.md) | How a raw fact ("Alex works at Sage") becomes resolved, typed edges; entity resolution; the develops-vs-uses classification step |
| [`guides/07-build-order-and-checklist.md`](guides/07-build-order-and-checklist.md) | The exact order an agent should build this in, with a migration path from the current schema and acceptance tests |
| [`api/08-api-conventions.md`](api/08-api-conventions.md) | The API structure format: auth, versioning, cursors, the filter DSL, field groups, confidence/evidence knobs, errors, credits — benchmarked against Crustdata with explicit copy-vs-deviate calls |
| [`api/09-api-endpoints.md`](api/09-api-endpoints.md) | The full endpoint catalog (23 routes): every question in the brief → its call, worked filter examples, watchers/changes for job-change & displacement signals, batch, and the API build order |
| [`api/openapi.yaml`](api/openapi.yaml) | The machine-readable OpenAPI 3.1 contract for all 23 routes — the file codegen and the server build from; 08/09 are its rationale |

## 4. Non-negotiable principles carried from the existing docs

Everything here obeys the rules the existing schema already set, so this package drops in rather than forking:

1. **Prefixed ULID primary keys** (`org_`, `pn_`, `tech_`, `rel_`, `sk_`, …).
2. **Every relationship row is bitemporal** (`valid_from` / `valid_to` = when the fact was true in the world; `recorded_at` = when we learned it) and carries `source_id` + `confidence`. A relationship is a *claim with provenance*, never a bare fact.
3. **Raw-as-seen is preserved next to the resolved key** — `company_name_raw` sits beside `company_id`; `school_name` beside `org_id`. Resolution can be redone; the audit trail survives.
4. **Postgres holds truth; ClickHouse/graph projections hold the scan.** Heavy traversals ("all people two hops from any Sage product") run on a projection, not OLTP.
5. **Confidence composes by dampened, source-deduplicated Noisy-OR** — corroborations of the same edge raise confidence, but sources are deduplicated first and the product is dampened, because web sources copy each other and naive independence over-counts (TruthFinder, KDD 2007; Knowledge Vault, KDD 2014 — mechanics and citations in file `04` §1).

## 5. Research foundations — what mature platforms do, and what it changed here

Every load-bearing decision was checked against deployed data platforms and knowledge graphs (research pass, 2026-08). Full citations sit at the decision points in files `02`–`06`; this is the map.

| Decision in this package | Prior art that does the same | Source |
|---|---|---|
| A few typed edge tables, not one generic `edges` table | Neo4j: specific relationship types, never generic-plus-property (measured ~50% fewer db hits); Karwin: generic relationship tables are the EAV anti-pattern | [Neo4j](https://medium.com/neo4j/cypher-optimization-names-relationship-types-bc65e6f81f53) · [Karwin](https://www.oreilly.com/library/view/sql-antipatterns/9781680500073/f_0037.html) |
| …but variants as an enum *within* a domain, not a table per variant | Neo4j's 65,536-type ceiling + update-complexity warning; TAO's per-`(id1, type)` association lists | [Neo4j KB](https://neo4j.com/developer/kb/explanation-of-error-record-id-65536-is-out-of-range/) · [TAO](https://engineering.fb.com/2013/06/25/core-infra/tao-the-power-of-the-graph/) |
| Companies and schools in one `organizations` table | Diffbot resolves employer AND institution to one `Organization` type; Crunchbase `degrees.institution_uuid` points into the same organizations collection (role discriminator). LinkedIn is the counterexample (separate company/school taxonomies) — see 02 §1 for why we side with the KG-style unification | [Diffbot](https://www.diffbot.com/docs/ontology/person) · [Crunchbase](https://support.crunchbase.com/hc/en-us/articles/32197713858195-CSV-Export-FAQ) |
| Employment and education as separate edge tables with different payloads | Unanimous across providers: Crunchbase `jobs.csv` vs `degrees.csv`; PDL `experience[]` vs `education[]`; Diffbot `employments[]` vs `educations[]`; Apollo `employment_history` | [PDL](https://docs.peopledatalabs.com/docs/fields) · [Diffbot](https://www.diffbot.com/docs/ontology/person) |
| `develops` and `uses` as distinct relations + a separate bitemporal ownership ledger | Wikidata: `developer` (P178) is a *different property* from time-qualified `owned by` (P127, start/end/proportion qualifiers); BuiltWith's schema is usage-only — the maker appears nowhere as a relation | [P178](https://www.wikidata.org/wiki/Property:P178) · [P127](https://www.wikidata.org/wiki/Property:P127) · [BuiltWith](https://api.builtwith.com/domain-api) |
| `first_seen / last_seen / detection_method` on usage rows | BuiltWith `FirstDetected`/`LastDetected` per path with liveness derived from recency; HG Insights "first detected / last verified"; Wappalyzer keys detection by method with per-pattern confidence | [BuiltWith](https://api.builtwith.com/domain-api) · [webappanalyzer](https://github.com/enthec/webappanalyzer/blob/main/README.md) |
| Raw string kept beside the resolved FK | PDL stores `raw` beside the resolved school and warns the resolved id is **non-persistent**; Apollo pairs `organization_id` + `organization_name` on every edge; LinkedIn runs a standing pipeline just to re-match raw company names | [PDL](https://docs.peopledatalabs.com/docs/fields) · [LinkedIn Eng.](https://engineering.linkedin.com/blog/2022/matching-external-companies-to-linkedin-s-economic-graph-at-scal) |
| Statement-level provenance (source, time-scope, status per edge) | Wikibase: references and time qualifiers attach *per statement*; ranks retire claims without deleting them — "not about the truth, but about statements and their references" | [Wikibase primer](https://www.mediawiki.org/wiki/Wikibase/DataModel/Primer) |
| Bitemporal close-don't-delete | Fowler: without both time axes, corrections are indistinguishable from real-world change; SQL:2011 application-time + system-versioned tables; Kimball SCD Type 2 | [Fowler](https://martinfowler.com/articles/bitemporal-history.html) · [SQL:2011](https://dl.acm.org/doi/10.1145/2380776.2380786) |
| Dampened, deduplicated confidence fusion | TruthFinder's `1 − Π(1 − c_i)` **with a dampening factor for copying sources**; Knowledge Vault: dedupe sources, dampen counts (√n), learn per-source reliability, calibrate — and deliberately never assumes independence | [TruthFinder](https://dl.acm.org/doi/10.1145/1281192.1281309) · [Knowledge Vault](https://www.cs.ubc.ca/~murphyk/papers/kv-kdd14.pdf) |
| Postgres holds truth; projections hold the deep scan | Recursive CTEs hold up at 2–4 hops and degrade hard near 10; CDC/outbox feeds read models with at-least-once delivery and per-entity ordering | [CTE limits](https://evokoa.com/blog/postgres-as-a-graph-database/) · [Debezium outbox](https://debezium.io/blog/2019/02/19/reliable-microservices-data-exchange-with-the-outbox-pattern/) |

**What the research changed** (vs. the first draft of this package):

1. **`deprecated_use` is gone.** Removal of a usage fact is now *only* a closed `uses` row (`valid_to` set) — the industry derives liveness from detection recency (BuiltWith's `LIVEONLY` filter), and a second encoding of "stopped using" would be two sources of truth for one fact. The displacement signal is "recently closed `uses` rows" (03 §2, 05 §4).
2. **The edge uniqueness key became a partial index** (`WHERE valid_to IS NULL`) — a plain UNIQUE forbids re-adoption (close, then later re-open the same org–tech pair), which breaks the bitemporal model (03 §2).
3. **Alias and identifier tables were added** for organizations and technologies (02 §2, 03 §1) — resolution was specified to block on aliases, but no alias substrate existed. PDL's non-persistent-ID warning and LinkedIn's standing matching pipeline show resolution is a *permanent* subsystem; it needs durable alias/identifier tables.
4. **Attestations gained a per-sighting `confidence`** and the fusion rule became *dedupe by source → dampen → combine* — naive Noisy-OR double-counts correlated sources (04 §1–2).
5. **Usage rows gained `detected_on_domain`** — the documented technographics false-positive class is agency/stale detections; recording where the fingerprint fired keeps misattribution auditable, following BuiltWith's per-path precedent (03 §2).
6. **`alumnus` is no longer an asserted type** — current-vs-past student status is derived from dates, as providers do (Diffbot `isCurrent`, Crunchbase `completed_on`); asserting it stores derivable state that drifts (02 §4).

---

## 6. The one-sentence summary

> Model people, companies, schools, and technologies as nodes, and connect them with **a few typed, directional, provenanced relationship tables** — one per domain — so that *develops*, *uses*, *works-at*, and *studied-at* are distinct edges that a query can traverse independently, while sharing one catalog of organizations and one catalog of technologies underneath.
