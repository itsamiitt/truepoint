# 06 — Ingestion & Resolution: turning raw facts into typed edges

How a raw statement like *"Alex — Software Engineer at Sage"* or *"Sage Intacct — an accounting product by Sage"* becomes resolved, typed, provenanced rows in the schema. This is the pipeline your agent builds to *populate* the graph, and the one place a genuinely hard classification lives: **deciding whether a company→technology fact is `develops` or `uses`.**

Carries the capture pipeline the person doc already defines; adds the relationship-typing and resolution steps.

---

## 1. The pipeline in one line

```
raw payload → capture envelope (Iceberg lake) → extract structured facts →
resolve entities (Splink) → classify relationship type → write typed edge + attestation (bitemporal) → project
```

Nothing is invented; each stage below says what it does for *relationships* specifically.

---

## 2. Stage 1 — Capture (unchanged)

Raw provider/web payloads land in the lake with an envelope: `source_id`, `license_class`, `content_hash`, `fetched_at`. Suppression check runs here (person doc §7) before any personal value is landed. Relationship facts never bypass capture — every edge traces to a captured payload.

## 3. Stage 2 — Extract structured facts

A parser (structured providers) or LLM extractor (unstructured web text) turns the payload into candidate **fact triples** with the raw strings preserved:

```
(person="Alex Mehta", raw_org="Sage",  role="Software Engineer", kind=employment, dates=2021-03..now)
(person="Alex Mehta", raw_org="SPPU",  degree="B.Tech",          kind=education,  dates=2015..2019)
(org="Sage",  raw_tech="Sage Intacct", hint="product",           kind=org_tech)
(org="Sage",  raw_tech="WordPress",    hint="detected_on_website",kind=org_tech)
(org="Google",raw_tech="Google Analytics", hint="product",       kind=org_tech)
```

Each triple keeps its raw strings (`raw_org`, `raw_tech`) — these become the `*_raw` columns, so resolution can be redone later without re-fetching.

## 4. Stage 3 — Resolve entities (Splink)

Every raw string resolves to a canonical node ID, or creates one:

- **Person resolution** — on `person_identifiers` + name/company/location blocking → `person_id`. (Person doc.)
- **Organization resolution** — the [NEW] part: `raw_org` resolves against `organizations` regardless of `org_kind`, in two tiers backed by the tables in `02` §1b: **identifier hits are deterministic** (`organization_identifiers` — a domain or wikidata_qid match is an anchor, one org per identifier), **alias hits are candidates** (`organization_aliases` via `lower(alias)`) scored probabilistically by Splink. "Sage" → `org_01SAGE…` (company); "SPPU" → `org_01SPPU…` (school). **The same resolver handles companies and schools** because they share the table — one blocking model on `legal_name`/`display_name`/identifiers/aliases. If a school isn't found, a new `organizations` row with `org_kind='school'` is created.
- **Technology resolution** — `raw_tech` resolves against `technologies` + `technology_aliases` (+ `cpe23`/`wikidata_qid` anchors) → `technology_id`. "Sage Intacct" → `tech_01INTACCT…`; "GA4" → `tech_01GA…`.

Splink's mechanics fit this exactly: per-comparison match weights are log₂ Bayes factors (`log₂(m/u)`), summed and squashed to a match probability, with blocking rules to keep the comparison space tractable ([Splink Fellegi-Sunter guide](https://moj-analytical-services.github.io/splink/topic_guides/theory/fellegi_sunter.html)) — deployed at national-statistics scale ([StatCan census dedup](https://www150.statcan.gc.ca/n1/pub/11-522-x/2022001/article/00002-eng.pdf)). Note the docs give no org-specific comparison recipe — the name-tokenization/domain/geography comparison levels are ours to design. And resolution is *continuous*, not one-shot — LinkedIn runs a standing system for exactly this re-matching ([LinkedIn Eng.](https://engineering.linkedin.com/blog/2022/matching-external-companies-to-linkedin-s-economic-graph-at-scal)) — which is why every edge keeps its raw string: resolution writes the canonical ID *and* keeps `*_raw` for the re-run.

## 5. ⭐ Stage 4 — Classify the relationship type (the hard, important step)

For person→org, the type is usually given by the source (`employment` vs `education` payload section) → `relationship_type` = `employee` / `student`. Easy.

For **org→technology, you must decide `develops` vs `uses`** — the same pair ("Sage", "Sage Intacct") is `develops`, but ("Sage", "WordPress") is `uses`. Signals that drive the classifier:

| Signal | Points to | Example |
|---|---|---|
| The org is the technology's `creator`/`owner` in `technology_vendors` | **develops** | Sage owns Sage Intacct → develops |
| The technology's canonical name shares the org's brand | **develops** (weak) | "Sage 50" ⊃ "Sage" |
| Detected via web-fingerprint / DNS / job-posting on the org's own site | **uses** | WordPress on sage.com → uses |
| Source is a product catalog / the org's "products" page | **develops** | sage.com/products lists Sage X3 |
| Source is a technographics provider (BuiltWith-style) | **uses** | provider says Sage runs GA |
| App-store / marketplace listing where org is publisher | **develops** | — |

**Decision procedure (deterministic core + confidence):**
```
if org is creator/current_owner of tech in technology_vendors:      type = develops (0.98)
elif source is product-catalog / publisher listing:                  type = develops (0.90)
elif detection_method in (webappanalyzer, dns, job_posting):         type = uses     (0.88)
elif technographics provider asserts adoption:                       type = uses     (0.90)
elif tech brand ⊂ org brand (name heuristic):                        type = develops (0.70, flag for review)
else:                                                                 type = uses     (0.60, flag for review)
```
Low-confidence classifications go to the review queue (same queue the person doc uses for resolution). **This classifier is the single most valuable piece of ingestion logic** — get it wrong and "what Sage builds" leaks "WordPress."

Two field-documented failure modes to defend against ([PredictLeads on technographic accuracy](https://predictleads.com/blog/technographic-data-accuracy/)): **mention ≠ deployment** ("a tool may be mentioned but not deployed" — a blog post about WordPress is not WordPress running), and **misattributed surfaces** (agency/vendor pages carrying someone else's fingerprints). Mitigations already in the schema: `uses` edges record `detected_on_domain` (03 §2) so every detection traces to the concrete surface that fired, and detections only count when the surface belongs to the org's verified domains (`organization_identifiers[domain]`). Per-pattern confidence (Wappalyzer-style) flows into the attestation's `confidence`, so a weak fingerprint never silently equals a strong one.

**Consistency rule:** writing a `develops` edge for (Sage, Sage Intacct) also asserts/refreshes the matching `technology_vendors` `current_owner` row, keeping the portfolio view and the ownership ledger in agreement (file `03` §2).

## 6. Stage 5 — Write the typed edge (bitemporal, idempotent)

Upsert semantics, not blind insert:

```
edge_key = (person_id|org_id, target_id, relationship_type)
if an OPEN edge with edge_key exists (valid_to IS NULL — the partial unique in 03 §2):
    # same fact re-seen — do NOT duplicate
    append a relationship_attestations row (with its own per-sighting confidence)
    recompute confidence = dedupe → dampen → combine          # file 04 §1
    refresh last_seen_at (uses rows)
else:
    insert the edge (valid_from = fact's real-world start, valid_to = NULL)
    append the first attestation
```

If a source says a previously-true edge has ended (Alex left Sage; Sage dropped WordPress):
```
close the edge: set valid_to = end_date, is_current = false (positions)
uses rows additionally close by STALENESS SWEEP: when last_seen_at exceeds the
detection window with no fresh sighting, set valid_to = last_seen_at
(liveness-from-recency, as BuiltWith's LIVEONLY derives it — 03 §2)
```
Closing, never deleting — history survives (except GDPR erasure of personal data, file `04` §4). Re-adoption later is a **new open row** for the same triple; the partial unique allows it and the closed row keeps the history.

## 7. Stage 6 — Project for scan

Debezium CDC fans edge changes to the read-optimized projections (person doc §5):
- `current_employment (org_id, person_id, function, seniority)` — "who works at Sage" at feed scale.
- `org_technology_current (org_id, technology_id, relationship_type)` — "what Sage develops/uses" columnar.
- Optional **graph projection** (a property-graph store or an in-memory adjacency structure) for deep multi-hop traversals ("everyone 3 hops from any Google product"). The boundary is measured, not aesthetic: recursive CTEs hit seconds at ~5 hops and timeouts near 10 on multi-million-row edge tables, while an adjacency projection over the same data answers multi-hop in milliseconds ([comparison](https://evokoa.com/blog/postgres-as-a-graph-database/)). 2–4 typed hops stay as OLTP joins (file `05`); deeper goes here.

Two binding disciplines from the CDC/outbox pattern ([Debezium outbox](https://debezium.io/blog/2019/02/19/reliable-microservices-data-exchange-with-the-outbox-pattern/)): delivery is **at-least-once**, so every projector is idempotent (track processed event ids); and ordering is guaranteed **per entity only** (key messages by canonical entity id) — never build projection logic that needs cross-entity global order. If/when the edge tables shard (Citus), distribute the relationship tables by their org-side key so org-centric joins stay node-local ([co-location](https://learn.microsoft.com/en-us/azure/cosmos-db/postgresql/concepts-colocation)) — but note sharding does not rescue deep traversal; only the projection does.

---

## 8. Worked end-to-end: three facts from your example

**Fact 1 — "Alex works at Sage" (from a licensed provider):**
```
extract  → (person="Alex Mehta", raw_org="Sage", role="Software Engineer", kind=employment)
resolve  → person_id=pn_01ALEX…, org_id=org_01SAGE…
classify → relationship_type = employee (given by source section)
write    → person_positions(pos_01…, pn_01ALEX…, org_01SAGE…, 'Sage', 'employee', 'Software Engineer', is_current=true, confidence=0.90)
attest   → relationship_attestations(person_positions, pos_01…, licensed_provider, "Alex Mehta — Software Engineer, Sage")
```

**Fact 2 — "Sage Intacct is a product by Sage" (from sage.com/products):**
```
extract  → (org="Sage", raw_tech="Sage Intacct", hint="product_catalog")
resolve  → org_id=org_01SAGE…, technology_id=tech_01INTACCT…
classify → source is product-catalog → develops (0.90); also refresh technology_vendors current_owner=Sage
write    → org_technology_relations(rel_01…, org_01SAGE…, tech_01INTACCT…, 'develops', is_primary_product=true, confidence=0.90)
```

**Fact 3 — "WordPress detected on sage.com" (from a technographics crawl):**
```
extract  → (org="Sage", raw_tech="WordPress", detection_method="webappanalyzer")
resolve  → org_id=org_01SAGE…, technology_id=tech_01WORDPRESS…
classify → detection_method=webappanalyzer → uses (0.88)
write    → org_technology_relations(rel_02…, org_01SAGE…, tech_01WORDPRESS…, 'uses', first_seen_at=…, detection_method='webappanalyzer', confidence=0.88)
```

Facts 2 and 3 both connect Sage to a technology, but the classifier routed them to different `relationship_type`s — so the graph stays correct.

---

## 9. Review-queue triggers (what a human/agent checks)

- Org→tech classified `develops` by name-heuristic only (no vendor/ catalog corroboration).
- A technology with both `develops` and `uses` edges from the *same* org (usually fine — a vendor dogfooding its own product — but flag once).
- A `uses` detection whose `detected_on_domain` is NOT among the org's verified domains (the agency-misattribution case — 03 §2).
- A new `organizations` row created with `org_kind='school'` from a single low-reliability source.
- Any edge whose fused confidence stays below 0.6 after all attestations.
- A `uses` row auto-closed by the staleness sweep whose org is an active customer-facing account (a displacement signal about to fire — verify before it triggers outreach).
