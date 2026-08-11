# 04 — Schema: Shared Provenance, Bitemporality & Attestations

Every relationship table in files `02`–`03` embeds the same block of columns. This file defines that block once, explains *why* each column exists, and adds the cross-relationship attestation table that lets the graph answer "how do we know this edge is true?"

The principle carried from the existing docs: **a relationship is not a bare fact — it is a claim, with a source, a confidence, and a validity period.** Two sources both saying "Alex works at Sage" should raise confidence, not create a duplicate; a fact that stopped being true (Alex left) should be closed, not deleted.

---

## 1. The standard provenance block (on every edge table)

```sql
-- embedded in person_positions, person_educations, org_technology_relations,
-- technology_vendors, company_edges, and organizations/technologies themselves:
    source_id     TEXT NOT NULL REFERENCES sources(source_id),   -- which source asserted this
    confidence    NUMERIC(4,3) NOT NULL,                         -- 0.000–1.000, current belief
    valid_from    TIMESTAMPTZ NOT NULL,                          -- when the fact became TRUE in the world
    valid_to      TIMESTAMPTZ,                                   -- when it stopped (NULL = still true)
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()             -- when WE learned it
```

### Why bitemporal (`valid_*` vs `recorded_at`)?

Two independent time axes, both needed:

- **Valid time** (`valid_from`/`valid_to`) — the real-world truth window. "Alex worked at Sage from 2021-03 onward" → `valid_from='2021-03-01'`, `valid_to=NULL`. If Alex leaves in 2026, you *close* the row (`valid_to='2026-04-01'`), you don't delete it — the history that Alex once worked there stays true-of-the-past.
- **Transaction time** (`recorded_at`) — when the database learned it. If a provider tells you in 2026 about a job change that happened in 2021, `valid_from=2021`, `recorded_at=2026`. This is what lets you answer "what did we believe on date X" and reconstruct the graph as-of any past moment — the `as_of` query in file `05`.

The Martin-Fowler retroactive-change example the technology doc cites is exactly this: "Sage Intacct was owned by Intacct Inc., which Sage acquired effective 2017-07-28, a fact we recorded on 2017-08-02." Valid time = acquisition date; transaction time = when we found out.

This is textbook, not invention: Fowler — *"actual history records what history should be given perfect transmission of information, while record history captures how our knowledge of history changes"* — and his point that without both axes, **corrections are indistinguishable from genuine changes**, which kills audit ([Bitemporal History](https://martinfowler.com/articles/bitemporal-history.html)). SQL:2011 standardizes the same pair as application-time period tables (our `valid_*`) and system-versioned tables (our `recorded_at` lineage) ([Kulkarni & Michels, SIGMOD Record 2012](https://dl.acm.org/doi/10.1145/2380776.2380786)); close-then-insert with a current flag is Kimball's SCD Type 2 ([Kimball Group](https://www.kimballgroup.com/data-warehouse-business-intelligence-resources/kimball-techniques/dimensional-modeling-techniques/type-2/)). One precision worth stating: the edge row holds the *current belief* (its `confidence` is recomputed in place); the full record-history axis lives in the **append-only attestation log** below plus `recorded_at` — "what did we believe on date X" is answered from attestations, not from edge-row archaeology.

### Why `confidence` per edge (not per node)?

Because the *same* edge can be asserted by sources of differing reliability, and corroboration should compound. "Alex works at Sage" from a licensed provider (0.9) *and* from a company-website team page (0.85) is more believable than either alone.

The base rule is **Noisy-OR** — `1 − Π(1 − c_i)` — which is TruthFinder's fact-confidence formula ([Yin, Han & Yu, KDD 2007](https://dl.acm.org/doi/10.1145/1281192.1281309)). But both canonical treatments refuse the naive independence assumption, because **web sources copy each other**: TruthFinder introduces a dampening factor for exactly this; Google's Knowledge Vault avoids independence-based fusion entirely — it deduplicates sources before extraction, dampens repeat counts (√n, "to reduce the effect of very commonly expressed facts"), learns per-source reliability weights, and calibrates the output with Platt scaling ([Dong et al., KDD 2014, §3.2–3.3](https://www.cs.ubc.ca/~murphyk/papers/kv-kdd14.pdf)). Two crawls of the same team page are one observation, not two.

So the rule here is **dedupe → dampen → combine**:

```
1. Deduplicate: keep the single strongest attestation per source_id
   (and collapse near-identical raw_assertions across mirrors).
2. Dampen:      γ = 0.8 discounts residual correlation between the survivors.
3. Combine:     confidence = 1 − Π(1 − γ·c_i)

   = 1 − (1 − 0.8·0.9)(1 − 0.8·0.85) = 1 − (0.28)(0.32) = 0.910
```

Corroboration still compounds (0.910 > 0.9), but two correlated sightings can no longer masquerade as near-certainty (naive Noisy-OR would claim 0.985). Per-source reliability enters through each attestation's own confidence (`source.reliability × sighting strength` — §2), which is the poor-man's version of Knowledge Vault's learned per-source weights; upgrade path if calibration ever matters: hold out a labeled sample and Platt-scale, exactly as KV does.

Which requires… an attestation table.

---

## 2. `relationship_attestations` — every independent sighting of every edge [NEW]

The person doc has `contact_attestations` for emails/phones. This generalizes the same idea to *all* relationship edges, so any edge can answer "where did this come from, when, from how many independent sources."

```sql
CREATE TABLE relationship_attestations (
    attestation_id   TEXT PRIMARY KEY,                  -- att_<ULID>
    edge_table       TEXT NOT NULL,                     -- 'person_positions' | 'org_technology_relations' | …
    edge_id          TEXT NOT NULL,                     -- the rel_/pos_/edu_/tv_ id (soft ref; prefix routes)
    source_id        TEXT NOT NULL REFERENCES sources(source_id),
    source_class     TEXT NOT NULL,                     -- licensed_provider | web_public | registry | self_declared
    confidence       NUMERIC(4,3) NOT NULL,             -- THIS sighting's strength: source reliability × pattern/extractor confidence
    raw_assertion    TEXT,                              -- what the source literally said ("Alex — Software Engineer at Sage")
    seen_at          TIMESTAMPTZ NOT NULL,
    license_class    TEXT NOT NULL                      -- inherited from capture envelope
);
CREATE INDEX idx_relatt_edge ON relationship_attestations (edge_table, edge_id, seen_at DESC);
```

**Rows for "Alex works at Sage":**
```
edge_table         edge_id       source_class        confidence   seen_at       (raw_assertion)
person_positions   pos_01ALEX…   licensed_provider   0.900        2026-07-28    "Alex Mehta — Software Engineer, Sage"
person_positions   pos_01ALEX…   web_public          0.850        2026-03-11    "Alex Mehta | Sage | Engineering"
```
Two sightings from **distinct sources** → the position row's `confidence` recomputes to 0.910 by the dedupe→dampen→combine rule (§1). The per-sighting `confidence` column is what the fusion consumes: Wappalyzer attaches confidence to each detection *pattern*, not to the technology ([webappanalyzer spec](https://github.com/enthec/webappanalyzer/blob/main/README.md)) — the sighting is the natural grain for belief, the edge is where it fuses.

This per-statement evidence trail is the Wikibase reference model in relational form — references attach to *statements*, not entities, and "a claim without references is not necessarily wrong, nor is a claim with references true" ([Wikibase primer](https://www.mediawiki.org/wiki/Wikibase/DataModel/Primer)). Diffbot ships the nearest commercial equivalent (`origins`/`originDetails`/`nbOrigins` per fact — URLs and counts, but **no confidence numbers**); this table carries both the origins *and* a calibrated belief, which is the differentiator: you can show the evidence trail behind "Sage develops Sage Intacct" or "Alex studied at SPPU," which no incumbent graph exposes.

**Why one attestation table with `edge_table`/`edge_id` instead of one per edge type?** Attestations are append-only, write-heavy, and rarely joined *back* to the edge except for the "show evidence" surface. A single wide attestation log is cheaper to write and to scan than N parallel logs, and the soft `(edge_table, edge_id)` reference routes correctly by prefix. (Contrast with the *edges themselves*, which stay in typed tables for FK integrity — the trade-off is deliberate and opposite for the two layers.)

---

## 3. The `sources` table (referenced everywhere, from capture doc)

Carried for completeness — every `source_id` above points here.

```sql
CREATE TABLE sources (
    source_id     TEXT PRIMARY KEY,                     -- src_<ULID>
    name          TEXT NOT NULL,                        -- "PDL", "Coresignal", "sage.com/about"
    source_type   TEXT NOT NULL,                        -- licensed_provider | web_crawl | registry | manual
    license_class TEXT NOT NULL,                        -- provider_b2b_resale | open_web | registry_public
    reliability   NUMERIC(4,3),                         -- prior weight feeding confidence
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 4. How a fact updates over time (worked lifecycle)

"Alex works at Sage" across its life:

1. **First sighting** (2026-03, web) → insert `person_positions` row, `confidence=0.85`, `valid_from=2021-03` (as stated), `valid_to=NULL`, `is_current=true`; insert one attestation.
2. **Corroboration** (2026-07, provider) → **no new position row**; insert a second attestation; recompute `confidence` by dedupe→dampen→combine (§1) → `0.910`. (A third crawl of the *same* team page adds an attestation for audit but changes nothing — deduped as a correlated source.)
3. **Job change** (2027, Alex moves to Google) → **close** the Sage row (`valid_to='2027-05-01'`, `is_current=false`), **insert** a new `person_positions` row for Google (`is_current=true`). The job-change *signal* falls out of this pair for free (person doc §2.3).
4. **Erasure request** (GDPR) → the one exception: personal data is hard-deleted, not closed (person doc §7). Relationship edges about *public professional facts* generally survive; personal contact rows do not.

Every step preserves history and provenance. Nothing is silently overwritten.

---

## 5. Column-level summary

| Column | On every edge? | Purpose |
|---|---|---|
| `<prefix>_id` | Yes | ULID primary key |
| both endpoint FKs | Yes | Real referential integrity (the reason not to use one universal edge table) |
| `relationship_type` | Yes (domains A, B, C, E) | The label that keeps traversals separate |
| `source_id`, `confidence` | Yes | Provenance + belief |
| `valid_from`, `valid_to` | Yes | Real-world truth window (bitemporal) |
| `recorded_at` | Yes | When we learned it (bitemporal) |
| `*_raw` (name as seen) | Where resolved | Audit + re-resolution |
| attestations | Via `relationship_attestations` | Independent-sighting evidence trail |
