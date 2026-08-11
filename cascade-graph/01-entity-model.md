# 01 — The Entity-Relationship Model

The complete picture: what the nodes are, what the edges are, and how they compose to answer your example. DDL comes in files `02`–`04`; this file is the map you hold in your head while reading them.

---

## 1. Nodes (the things)

Four node types. Two of them are backed by **one physical table each with a `kind` discriminator**, which is the trick that keeps the relationship tables small.

| Node | Physical table | Discriminator | Examples |
|---|---|---|---|
| **Person** | `persons` | — | Alex, Siya |
| **Organization** | `organizations` | `org_kind`: `company` \| `school` \| `nonprofit` \| `government` | Sage (company), Google (company), SPPU (school), DPU (school) |
| **Technology** | `technologies` | `tech_kind`: `product` \| `platform` \| `service` \| `library` | Sage Intacct, Sage 50, Sage X3, WordPress, Google Analytics, Google Keyword Planner |
| **Skill** | `skills` | `skill_kind`: `general` \| `technology` \| `certification` | "Strategic Sourcing", "SAP MM" |

> **Why organizations, not companies+schools as separate tables?** Because "Alex works at Sage" and "Alex studied at SPPU" are the *same shape* of fact — a person linked to an institution with a role and dates. If schools lived in their own table, you'd need a parallel `person_school` subsystem duplicating everything in `person_positions`. One `organizations` table with `org_kind` lets a single person→org relationship model carry both, distinguished by relationship type. Sage and SPPU are peers; only their `org_kind` differs. **[NEW]**
>
> This is how the knowledge-graph-style providers do it: Diffbot resolves both `employments[].employer` and `educations[].institution` into one `Organization` entity type ([Diffbot person ontology](https://www.diffbot.com/docs/ontology/person)), and Crunchbase's export points `degrees.institution_uuid` into the same organizations collection its `jobs` table uses, with a role discriminator ([Crunchbase CSV export](https://support.crunchbase.com/hc/en-us/articles/32197713858195-CSV-Export-FAQ)). LinkedIn is the honest counterexample — it maintains companies (67M) and schools (133K) as separate taxonomies ([Economic Graph](https://engineering.linkedin.com/data/economic-graph-research/economic-graph-details)) — but LinkedIn's taxonomies serve human-curated browse surfaces; for a graph whose entity resolution, provenance, and traversal machinery must be *shared* across institution kinds, the unified table wins (02 §1).

> **Why is Technology separate from Skill?** The technology doc already decided this: a technology is a concrete product (vendor, versions, pricing, CPE key); a skill is an abstract competency. "Sage Intacct" (the product Sage sells) and "Sage Intacct administration" (a competency a person has) are different nodes bridged by an optional map. This package keeps that split and focuses on the *organization*↔*technology* edges.

---

## 2. Edges (the relationships) — the five domains

Every arrow in your example is one of these five relationship domains. Each is a table with a **real foreign key on both endpoints** and a `relationship_type` enum for the variants within the domain.

### Domain A — Person → Organization (employment)
**Table:** `person_positions` *(exists in person doc; extended here with `relationship_type`)*
**Answers:** "Alex works at Sage", "Siya works at Sage"

```
Alex ──[employee, 2021–now]──▶ Sage
Siya ──[employee, 2019–now]──▶ Sage
```
Types: `employee` · `founder` · `board_member` · `advisor` · `contractor` · `intern`.

Every provider surveyed models employment as its own typed edge with a role/title payload — Crunchbase `jobs.csv` (`job_type`, `is_current`), PDL `experience[]`, Diffbot `employments[]`, Apollo `employment_history` — none uses a generic person↔org edge. The payload split from education (below) is unanimous industry practice.

### Domain B — Person → Organization (education)
**Table:** `person_educations` *(exists; upgraded from free-text `school_name` to an `org_id` FK)*
**Answers:** "Alex studied at SPPU", "Siya studied at DPU"

```
Alex ──[student, 2015–2019, B.Tech]──▶ SPPU
Siya ──[student, 2016–2020, B.E.]────▶ DPU
```
Type: `student` (room for future variants). **Alumnus is derived, not asserted** — a `student` row whose `ended_year` has passed *is* an alumnus, exactly as Diffbot derives it from `isCurrent`/dates and Crunchbase from `completed_on`; storing it as a separate type would be derivable state that drifts. Same person→org substrate as Domain A — different table because education carries degree/field columns employment doesn't. (And note the unified-org payoff: a *professor* at SPPU is a `person_positions[employee]` row pointing at the school — no third subsystem needed.)

### Domain C — Organization → Technology (the develops-vs-uses fix) **[NEW]**
**Table:** `org_technology_relations`
**Answers:** "Sage developed Sage Intacct", "Sage uses WordPress"

```
Sage ──[develops]──▶ Sage Intacct
Sage ──[develops]──▶ Sage 50
Sage ──[develops]──▶ Sage X3
Sage ──[uses]─────▶ WordPress
Sage ──[uses]─────▶ Google Analytics
Sage ──[uses]─────▶ Google Keyword Planner
Google ─[develops]▶ Google Analytics
Google ─[develops]▶ Google Keyword Planner
```
Types: **`develops`** (the company builds/sells it) · **`uses`** (technographics — the company runs it internally) · `resells`. A usage that *ends* (WordPress removed from sage.com) is the same `uses` row **closed** (`valid_to` set) — not a separate type; "recently closed `uses` rows" is the displacement signal (03 §2, 05 §4). **This is the single most important table in the package** — it is what lets one query return "what Sage builds" and a different query return "what Sage runs," from the same company node, without confusion. Wikidata draws the identical line: `developer` (P178) and time-qualified `owned by` (P127) are different properties, never conflated with usage.

### Domain D — Technology → Organization (vendor / ownership)
**Table:** `technology_vendors` *(exists in technology doc)*
**Answers:** "Google Analytics was created by Google" (the inverse view of Domain C's `develops`, but bitemporal for acquisitions)

```
Google Analytics ──[creator]──▶ Google
Sage Intacct ──────[creator]──▶ Intacct Inc. ──[acquired 2017]──▶ current_owner: Sage
```
Types: `creator` · `current_owner` · `former_owner`. **Why both C-`develops` and D-`creator`?** `develops` is the *live product-portfolio* relation (fast, denormalized, "what does Sage sell today"); `technology_vendors` is the *historical ownership ledger* (bitemporal, survives acquisitions, "who owned this in 2016"). They agree today and diverge across M&A. File `03` explains the division of labor precisely.

### Domain E — Organization → Organization
**Table:** `company_edges` *(exists in company/propagation docs)*
**Answers:** value-chain and corporate structure ("Sage supplies X", "Sage is parent of Y")
Types: `supplies` · `buys_from` · `parent_of` · `subsidiary_of` · `competitor` · `partner`.

---

## 3. The whole example as one graph

```
                    ┌─────────── person_educations [student] ──────────┐
                    │                                                   ▼
   ┌────────┐       │                                              ┌────────┐
   │  Alex  │───────┤                                              │  SPPU  │  (org_kind=school)
   └────────┘       │                                              └────────┘
        │           └──── person_positions [employee] ───┐
        │                                                 ▼
        │                                            ┌────────┐   org_technology_relations [develops]   ┌──────────────┐
        │                                            │  Sage  │─────────────────────────────────────────▶│ Sage Intacct │
        │                                            │(company)│─────────────────────────────────────────▶│   Sage 50    │
        └── (Siya works here too) ───────────────────│        │─────────────────────────────────────────▶│   Sage X3    │
   ┌────────┐    person_positions [employee]         │        │                                          └──────────────┘
   │  Siya  │────────────────────────────────────────▶│        │   org_technology_relations [uses]        ┌──────────────┐
   └────────┘                                         │        │─────────────────────────────────────────▶│  WordPress   │
        │                                             └────────┘─────────────────────────────────────────▶│ Google Anal. │──┐
        │  person_educations [student]                                                                     │ GKeyword Pl. │  │
        ▼                                                                                                  └──────────────┘  │
   ┌────────┐                                                        technology_vendors [creator]                            │
   │  DPU   │  (org_kind=school)                        ┌────────┐◀──────────────────────────────────────────────────────────┘
   └────────┘                                           │ Google │  (org_kind=company)
                                                        └────────┘  org_technology_relations [develops] ▶ Google Analytics, GKeyword Planner
```

Read the arrows by their **label**, and each question in your brief is one labeled traversal:

| Question | Traversal |
|---|---|
| Where does Alex work? | Alex ─`person_positions[employee]`→ ? |
| Who else works there? | Sage ◀─`person_positions[employee]`─ ? (Siya) |
| Where did Alex study? | Alex ─`person_educations[student]`→ ? (SPPU) |
| What did Sage build? | Sage ─`org_technology_relations[develops]`→ ? |
| What does Sage run? | Sage ─`org_technology_relations[uses]`→ ? |
| Who made the tools Sage runs? | Sage ─`[uses]`→ tech ─`technology_vendors[creator]`→ ? (Google) |
| What else did Google build? | Google ─`org_technology_relations[develops]`→ ? |

Not one of these traversals can accidentally return another's answer, because the relationship *type* is a filter on every hop.

---

## 4. How the domains compose (multi-hop)

The payoff is chaining labeled edges. Two examples your brief implies:

**"Find people at companies that *use* a Google product, for outreach about migrating off it."**
```
Google ─[develops]→ {GA, GKeyword} ◀─[uses]─ companies ◀─[employee]─ people(function=marketing)
```
Four hops, four different relationship types, one query (file `05`).

**"Find alumni of SPPU who now work at a company that builds ERP software."**
```
SPPU ◀─[student]─ people ─[employee]→ companies ─[develops]→ tech(category=erp)
```
This is why the domains must stay typed and share the `organizations`/`technologies` catalogs: the join keys line up, and each hop filters on its own relationship type.

---

## 5. What changes vs. the existing schema

| Existing | Change in this package |
|---|---|
| `companies` table | Generalized to `organizations` with `org_kind` (companies + schools + …). A compatibility view `companies` preserves old queries. **[NEW]** |
| `person_positions` | Gains `relationship_type` (default `employee`) so founder/board/advisor are distinguishable. **[extended]** |
| `person_educations.school_name` (free text) | Gains `org_id` FK to `organizations` (resolved school), keeps `school_name` as raw-seen. **[extended]** |
| `company_technologies` (usage only) | **Superseded** by `org_technology_relations` with `relationship_type` — now carries *develops* and *uses* and more. Old table becomes a view filtered to `type='uses'`. **[NEW]** |
| `technology_vendors` | Unchanged — remains the bitemporal ownership ledger, now explicitly paired with `develops`. |
| `company_edges` | Unchanged. |
| *(nothing — new)* | `organization_aliases`, `organization_identifiers`, `technology_aliases` — the durable resolution substrate the resolver blocks on (02 §2, 03 §1). **[NEW]** |

The migration is additive and reversible; file `07` gives the exact steps and the backfill.
