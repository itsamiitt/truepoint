# 03 — Schema: Technology Relationships (the develops-vs-uses fix)

The heart of the package. DDL for the `technologies` catalog and the two relationship domains that connect organizations to technologies: **`org_technology_relations`** (develops / uses / …) and **`technology_vendors`** (the bitemporal ownership ledger). This is where "Sage developed Sage Intacct" and "Sage uses WordPress" become distinct, non-confusable edges.

Assumes provenance columns from [`04-shared-provenance.md`](04-shared-provenance.md).

---

## 1. `technologies` — the catalog node (from the technology doc, carried here)

A concrete product/platform, distinct from a skill. Unchanged from the technology-layer doc except that its vendor link now has an explicit partner in `org_technology_relations`.

```sql
CREATE TABLE technologies (
    technology_id   TEXT PRIMARY KEY,                    -- tech_<ULID>
    canonical_name  TEXT NOT NULL,
    slug            TEXT UNIQUE NOT NULL,
    tech_kind       TEXT NOT NULL DEFAULT 'product',     -- product | platform | service | library
    category_id     TEXT REFERENCES technology_categories(category_id),
    description     TEXT,
    is_saas         BOOLEAN,
    is_open_source  BOOLEAN,
    pricing_model   TEXT[],
    cpe23           TEXT,                                -- optional external key
    wikidata_qid    TEXT,                                -- optional external key
    confidence      NUMERIC(4,3) NOT NULL,
    source_id       TEXT NOT NULL REFERENCES sources(source_id),
    valid_from      TIMESTAMPTZ NOT NULL,
    valid_to        TIMESTAMPTZ,
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Rows for the example:**
```
technology_id       canonical_name              tech_kind
tech_01INTACCT…     Sage Intacct                product
tech_01SAGE50…      Sage 50                     product
tech_01SAGEX3…      Sage X3                     product
tech_01WORDPRESS…   WordPress                   platform
tech_01GA…          Google Analytics            service
tech_01GKP…         Google Keyword Planner      service
```

### 1b. `technology_aliases` — the tech-resolution substrate [NEW]

The same fact arrives under different names from different detectors — "Google Analytics", "GA4", "gtag.js"; BuiltWith, Wappalyzer, and job postings each have their own naming. The catalog needs an alias table for the same reason organizations do (02 §1b); the `cpe23`/`wikidata_qid` columns on `technologies` are the identifier anchors (Wappalyzer's spec carries `cpe` for exactly this cross-referencing role).

```sql
CREATE TABLE technology_aliases (
    alias_id      TEXT PRIMARY KEY,                      -- tal_<ULID>
    technology_id TEXT NOT NULL REFERENCES technologies(technology_id),
    alias         TEXT NOT NULL,                         -- "GA4", "gtag.js", "Wordpress.org"
    alias_kind    TEXT NOT NULL DEFAULT 'variant',       -- variant | former_name | detector_name | abbreviation
    source_id     TEXT NOT NULL REFERENCES sources(source_id),
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (technology_id, alias)
);
CREATE INDEX idx_tech_alias_lookup ON technology_aliases (lower(alias));
```

---

## 2. ⭐ `org_technology_relations` — the develops-vs-uses table [NEW]

**The single most important table in this package.** One row = one organization related to one technology, with the `relationship_type` naming *how*. This replaces the old `company_technologies` (which could only express "uses").

```sql
CREATE TABLE org_technology_relations (
    rel_id            TEXT PRIMARY KEY,                  -- rel_<ULID>
    org_id            TEXT NOT NULL REFERENCES organizations(org_id),
    technology_id     TEXT NOT NULL REFERENCES technologies(technology_id),
    relationship_type TEXT NOT NULL,
        -- develops : the org builds/sells this technology (product portfolio)
        -- uses     : the org runs this technology internally (technographics)
        -- resells  : the org distributes someone else's technology
        -- NOTE: "stopped using" is NOT a type — it is this same row CLOSED (valid_to set). See below.
    -- usage-specific (NULL for develops rows)
    first_seen_at     TIMESTAMPTZ,                       -- when 'uses' was first detected   (BuiltWith: FirstDetected)
    last_seen_at      TIMESTAMPTZ,                       -- when 'uses' was last detected    (BuiltWith: LastDetected)
    detection_method  TEXT,                              -- webappanalyzer | job_posting | dns | self_declared
    detected_on_domain TEXT,                             -- WHERE the fingerprint fired (sage.com, careers.sage.com)
    -- develops-specific (NULL for uses rows)
    is_primary_product BOOLEAN,                          -- flagship vs. minor product
    launched_on       DATE,
    -- provenance block (see file 04)
    source_id         TEXT NOT NULL REFERENCES sources(source_id),
    confidence        NUMERIC(4,3) NOT NULL,
    valid_from        TIMESTAMPTZ NOT NULL,
    valid_to          TIMESTAMPTZ,
    recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- ONE OPEN edge per (org, tech, type) — but closed history may repeat (re-adoption).
-- A plain UNIQUE would forbid "used it, dropped it, adopted it again"; partial unique doesn't.
CREATE UNIQUE INDEX uniq_otr_open ON org_technology_relations (org_id, technology_id, relationship_type)
    WHERE valid_to IS NULL;
-- The two traversal directions, each typed:
CREATE INDEX idx_otr_org_type ON org_technology_relations (org_id, relationship_type) WHERE valid_to IS NULL;
CREATE INDEX idx_otr_tech_type ON org_technology_relations (technology_id, relationship_type) WHERE valid_to IS NULL;
-- idx_otr_org_type  : "what does Sage develop / what does Sage use"  (org → tech)
-- idx_otr_tech_type : "who develops WordPress / who uses WordPress"  (tech → org)
```

**Rows for the example — note the SAME `org_id` (Sage) with DIFFERENT types:**
```
org_id        technology_id     relationship_type
org_01SAGE…   tech_01INTACCT…   develops
org_01SAGE…   tech_01SAGE50…    develops
org_01SAGE…   tech_01SAGEX3…    develops
org_01SAGE…   tech_01WORDPRESS… uses
org_01SAGE…   tech_01GA…        uses
org_01SAGE…   tech_01GKP…       uses
org_01GOOGLE… tech_01GA…        develops
org_01GOOGLE… tech_01GKP…       develops
```

This is the whole fix. Two queries, same Sage node, no confusion:
```sql
-- What did Sage BUILD?  → Sage Intacct, Sage 50, Sage X3
SELECT technology_id FROM org_technology_relations
WHERE org_id='org_01SAGE…' AND relationship_type='develops' AND valid_to IS NULL;

-- What does Sage RUN?   → WordPress, Google Analytics, Google Keyword Planner
SELECT technology_id FROM org_technology_relations
WHERE org_id='org_01SAGE…' AND relationship_type='uses' AND valid_to IS NULL;
```

**How a usage ends — closure, not a type.** BuiltWith has no "removed" status: liveness is *derived from recency* (`LastDetected`, with a `LIVEONLY` filter), and HG Insights tracks "first detected / last verified" ([BuiltWith Domain API](https://api.builtwith.com/domain-api); [HG Insights](https://hginsights.com/blog/why-you-need-technology-intelligence/)). This schema does the same, made explicit: a staleness sweep closes `uses` rows whose `last_seen_at` exceeds the detection window (`valid_to = last_seen_at`), and a verified removal closes immediately. The **displacement signal** — the sales trigger "they just dropped WordPress" — is simply a recently closed `uses` row (query in file `05` §4), optionally joined with a fresh `uses` row in the same category naming the replacement, which is exactly how HG constructs displacement context (install + category movement). An earlier draft had a `deprecated_use` type for this; it was removed because a closed row *and* a type variant would be two encodings of one fact.

**Why `detected_on_domain`?** The documented false-positive class in technographics is misattribution — "a script may appear on a page but not be actively used," agency sites carrying client fingerprints, stale detections never revalidated ([PredictLeads on technographic accuracy](https://predictleads.com/blog/technographic-data-accuracy/)). Recording *where* the fingerprint fired (BuiltWith's per-`Path` grouping is the precedent) keeps every `uses` edge auditable back to a concrete surface, so an agency-page misfire can be traced and killed without guessing.

**Backward compatibility with the old `company_technologies`:**
```sql
CREATE VIEW company_technologies AS
  SELECT org_id AS company_id, technology_id, first_seen_at, last_seen_at,
         detection_method, confidence, source_id
  FROM org_technology_relations
  WHERE relationship_type = 'uses' AND valid_to IS NULL;
```
Every existing technographics query keeps working; it just now reads the `uses` slice of the unified table.

### Why `develops` here AND `technology_vendors` below?

This split has direct prior art: Wikidata models the maker and the owner as *different properties* — `developer` ([P178](https://www.wikidata.org/wiki/Property:P178), "organization or person that developed the item," explicitly distinguished from publisher/manufacturer/producer) vs `owned by` ([P127](https://www.wikidata.org/wiki/Property:P127), which takes `start time`/`end time`/`proportion` qualifiers so ownership statements are time-bounded and survive acquisitions). An acquisition there is two coexisting P127 statements with time qualifiers while P178 stays stable — functionally identical to this ledger's `creator | current_owner | former_owner` rows with validity intervals.

Because they answer different questions and have different performance shapes:

| | `org_technology_relations[develops]` | `technology_vendors` |
|---|---|---|
| Question | "What is Sage's product portfolio *today*?" | "Who has *ever owned* Sage Intacct, and when?" |
| Direction of convenience | org → tech (portfolio read) | tech → org (ownership history) |
| Time model | current-state (valid_to closes a discontinued product) | full bitemporal ledger across acquisitions |
| On acquisition | a new `develops` row appears for the acquirer; old one closes | the `creator` row is immutable; a new `current_owner` row opens |

They are kept in sync by the ingestion pipeline (file `06`): writing a `develops` edge also asserts/refreshes the corresponding `technology_vendors` `current_owner` row. Keeping both is deliberate redundancy for two access patterns — the same reason the person doc denormalizes `current_company_id` onto `persons` while also keeping `person_positions`.

---

## 3. `technology_vendors` — the bitemporal ownership ledger (from technology doc)

Carried verbatim. This is the acquisition-proof "who created / owns this" history. The `creator` row **never mutates**; ownership changes append new rows — Wikidata's time-qualified `owned by` (P127) ledger, in relational form.

```sql
CREATE TABLE technology_vendors (
    link_id           TEXT PRIMARY KEY,                  -- tv_<ULID>
    technology_id     TEXT NOT NULL REFERENCES technologies(technology_id),
    org_id            TEXT NOT NULL REFERENCES organizations(org_id),   -- was company_id
    relationship      TEXT NOT NULL,                     -- creator | current_owner | former_owner
    source_id         TEXT NOT NULL REFERENCES sources(source_id),
    confidence        NUMERIC(4,3) NOT NULL,
    valid_from        TIMESTAMPTZ NOT NULL,              -- when this ownership became true
    valid_to          TIMESTAMPTZ,                       -- closed when ownership transfers
    recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tv_tech ON technology_vendors (technology_id, relationship) WHERE valid_to IS NULL;
CREATE INDEX idx_tv_org  ON technology_vendors (org_id, relationship) WHERE valid_to IS NULL;
```

**Rows for the example (incl. the acquisition case):**
```
technology_id     org_id          relationship    valid_from   valid_to
tech_01GA…        org_01GOOGLE…   creator         2005-04-14   NULL       (Google made GA)
tech_01GA…        org_01GOOGLE…   current_owner   2005-04-14   NULL
tech_01INTACCT…   org_01INTACCT…  creator         1999-01-01   NULL       (Intacct Inc. made it — immutable)
tech_01INTACCT…   org_01INTACCT…  current_owner   1999-01-01   2017-07-28 (…until Sage bought it)
tech_01INTACCT…   org_01SAGE…     current_owner   2017-07-28   NULL       (Sage owns it now)
```

Now "who *created* Sage Intacct" (Intacct Inc., forever) and "who *owns* it now" (Sage, since 2017) are both answerable, and Sage's `develops` edge in §2 reflects the current portfolio while this ledger preserves the lineage.

---

## 4. `technology_categories` and `technology_skill_map` (from technology doc, carried)

```sql
CREATE TABLE technology_categories (
    category_id  TEXT PRIMARY KEY,                       -- cat_<ULID>
    name         TEXT NOT NULL,
    parent_id    TEXT REFERENCES technology_categories(category_id),
    path         LTREE                                   -- materialized path, fast subtree queries
);

-- bridge to the person-skill taxonomy: "Sage Intacct" the product ↔ "Sage Intacct admin" the competency
CREATE TABLE technology_skill_map (
    technology_id TEXT NOT NULL REFERENCES technologies(technology_id),
    skill_id      TEXT NOT NULL REFERENCES skills(skill_id),
    PRIMARY KEY (technology_id, skill_id)
);
```

This bridge is what lets "people *skilled in* Sage Intacct" (via `person_skills` → `skills` → `technology_skill_map`) join to "companies that *develop* Sage Intacct" (via `org_technology_relations`) — persona × product targeting as a join.

---

## 5. Node/edge summary for this file

```
organizations ──org_technology_relations[develops]──▶ technologies      (what a company builds)
organizations ──org_technology_relations[uses]──────▶ technologies      (what a company runs)
technologies  ──technology_vendors[creator|owner]───▶ organizations     (who made/owns it, bitemporal)
technologies  ──technology_skill_map────────────────▶ skills            (product ↔ competency bridge)
```

Combined with file `02`, the full graph is now expressible. File `04` gives the provenance columns; file `05` writes every example query.
