# 02 — Schema: Organizations & People (nodes + the person→org edges)

DDL for the node tables (`organizations`, `persons`) and the two person→organization relationship domains: **employment** (works-at) and **education** (studied-at). This file makes "Alex works at Sage", "Siya works at Sage", "Alex studied at SPPU", "Siya studied at DPU" first-class, resolved, provenanced facts.

Assumes the provenance columns defined in [`04-shared-provenance.md`](04-shared-provenance.md) — every relationship table below embeds the standard block (`source_id`, `confidence`, `valid_from`, `valid_to`, `recorded_at`).

---

## 1. `organizations` — the unified institution table (companies AND schools)

The central [NEW] change. Companies and schools are both organizations; a `org_kind` discriminator distinguishes them. This lets one person→org relationship substrate carry both "works at" and "studied at".

```sql
CREATE TABLE organizations (
    org_id            TEXT PRIMARY KEY,                  -- org_<ULID>
    org_kind          TEXT NOT NULL,                     -- company | school | nonprofit | government | other
    legal_name        TEXT NOT NULL,
    display_name      TEXT,
    primary_domain    TEXT,                              -- sage.com, sppu.edu.in
    country_code      CHAR(2),
    -- company-specific attributes (NULL for schools)
    employee_range    TEXT,                              -- "1001-5000"
    founded_year      SMALLINT,
    company_type      TEXT,                              -- private | public | subsidiary
    ticker            TEXT,
    -- school-specific attributes (NULL for companies)
    institution_type  TEXT,                              -- university | college | bootcamp
    -- shared
    confidence        NUMERIC(4,3) NOT NULL,
    source_id         TEXT NOT NULL REFERENCES sources(source_id),
    valid_from        TIMESTAMPTZ NOT NULL,
    valid_to          TIMESTAMPTZ,
    recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_org_kind      ON organizations (org_kind) WHERE valid_to IS NULL;
CREATE INDEX idx_org_domain    ON organizations (primary_domain) WHERE valid_to IS NULL;
-- Citus: shard by hash(org_id); distributes companies and schools alike.
```

**Rows for the example:**
```
org_id                          org_kind   legal_name
org_01SAGE…                     company    Sage Group plc
org_01GOOGLE…                   company    Google LLC
org_01SPPU…                     school     Savitribai Phule Pune University
org_01DPU…                      school     Dr. D. Y. Patil Vidyapeeth
```

**Backward compatibility:** existing queries that hit `companies` keep working via a view:
```sql
CREATE VIEW companies AS
  SELECT org_id AS company_id, legal_name AS name, primary_domain, country_code,
         employee_range, founded_year, company_type, ticker, confidence,
         source_id, valid_from, valid_to, recorded_at
  FROM organizations WHERE org_kind = 'company';
```

---

## 1b. `organization_aliases` + `organization_identifiers` — the resolution substrate [NEW]

The resolver (file `06` §4) blocks on names, aliases, domains, and external identifiers — so those need durable tables; without them "Sage Group plc", "Sage", and "SAGE GROUP PLC." are three different strings and resolution is a coin flip. Two lessons from the providers drive this: People Data Labs documents its resolved school `id` as **NON-PERSISTENT** — the raw name, not the vendor id, is the durable key ([PDL fields](https://docs.peopledatalabs.com/docs/fields)) — and LinkedIn operates a *standing* engineering system whose only job is matching raw external company names to canonical entities ([LinkedIn Eng., 2022](https://engineering.linkedin.com/blog/2022/matching-external-companies-to-linkedin-s-economic-graph-at-scal)). Resolution is a permanent subsystem, and this is its index.

```sql
CREATE TABLE organization_aliases (
    alias_id      TEXT PRIMARY KEY,                      -- oal_<ULID>
    org_id        TEXT NOT NULL REFERENCES organizations(org_id),
    alias         TEXT NOT NULL,                         -- "Sage", "Sage Group", "SPPU", "Pune University"
    alias_kind    TEXT NOT NULL DEFAULT 'trade',         -- legal | trade | former_name | acronym | localized
    source_id     TEXT NOT NULL REFERENCES sources(source_id),
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, alias)
);
CREATE INDEX idx_org_alias_lookup ON organization_aliases (lower(alias));

CREATE TABLE organization_identifiers (
    org_id        TEXT NOT NULL REFERENCES organizations(org_id),
    id_type       TEXT NOT NULL,                         -- domain | linkedin_slug | wikidata_qid | lei | crunchbase_uuid | duns
    id_value      TEXT NOT NULL,
    source_id     TEXT NOT NULL REFERENCES sources(source_id),
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id_type, id_value),
    UNIQUE (id_type, id_value)                           -- one org per external identity — the hard ER join key
);
```

**Rows for the example:**
```
org_id         alias                              alias_kind
org_01SAGE…    Sage                               trade
org_01SAGE…    Sage Group                         trade
org_01SPPU…    SPPU                               acronym
org_01SPPU…    Pune University                    former_name

org_id         id_type         id_value
org_01SAGE…    domain          sage.com
org_01SAGE…    wikidata_qid    Q660604
org_01SPPU…    domain          unipune.ac.in
```

`UNIQUE (id_type, id_value)` is what makes identifiers stronger than aliases: an alias is a *hint* (many orgs may be called "Sage" in some market); an external identifier is an *anchor* (exactly one org owns `sage.com`). The resolver treats identifier hits as deterministic matches and alias hits as candidates for probabilistic scoring — the same two-tier design as `person_identifiers` (person doc). Wikidata maintains the same split: aliases for matching, external-ID properties (with single-value constraints) for identity.

---

## 2. `persons` — unchanged from the person doc (slim identity core)

Carried verbatim so this package drops in. The denormalized `current_*` columns still point at an organization (a company).

```sql
CREATE TABLE persons (
    person_id          TEXT PRIMARY KEY,                 -- pn_<ULID>
    full_name          TEXT NOT NULL,
    first_name         TEXT,
    last_name          TEXT,
    headline           TEXT,
    location_text      TEXT,
    country_code       CHAR(2),
    current_org_id     TEXT REFERENCES organizations(org_id),   -- was current_company_id
    current_title      TEXT,
    current_function   TEXT,                             -- finance | procurement | engineering | …
    current_seniority  TEXT,                             -- c_level | vp | director | manager | ic
    confidence         NUMERIC(4,3) NOT NULL,
    valid_from         TIMESTAMPTZ NOT NULL,
    valid_to           TIMESTAMPTZ,
    recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`person_identifiers` (the entity-resolution backbone) is unchanged from the person doc — every external ID a source exposes becomes a row; Splink resolves on it.

---

## 3. Domain A — `person_positions` (works-at), extended with `relationship_type`

The person doc's employment table, plus a `relationship_type` so employee / founder / board_member / advisor are distinct edges rather than all flattened to "works here." `company_id` is renamed `org_id` (still FK to organizations, still only companies in practice — until the first professor row points it at a school, which now Just Works).

This shape is the industry-standard one: Crunchbase's `jobs` table carries the same `(person, org, title, started_on, ended_on, is_current, job_type)` grain, and Apollo's `employment_history` keeps `organization_id` *and* `organization_name` side by side on every row — the exact `org_id` + `company_name_raw` pairing here.

```sql
CREATE TABLE person_positions (
    position_id       TEXT PRIMARY KEY,                  -- pos_<ULID>
    person_id         TEXT NOT NULL REFERENCES persons(person_id),
    org_id            TEXT REFERENCES organizations(org_id),   -- NULL until resolved
    company_name_raw  TEXT NOT NULL,                     -- as-seen, for audit + re-resolution
    relationship_type TEXT NOT NULL DEFAULT 'employee',  -- employee | founder | board_member | advisor | contractor | intern
    title             TEXT,
    job_function      TEXT,                              -- normalized
    seniority         TEXT,
    description       TEXT,
    location_text     TEXT,
    started_on        DATE,                              -- month precision
    ended_on          DATE,
    is_current        BOOLEAN NOT NULL DEFAULT false,
    -- provenance block (see file 04)
    source_id         TEXT NOT NULL REFERENCES sources(source_id),
    confidence        NUMERIC(4,3) NOT NULL,
    valid_from        TIMESTAMPTZ NOT NULL,
    valid_to          TIMESTAMPTZ,
    recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pos_person   ON person_positions (person_id) WHERE valid_to IS NULL;
CREATE INDEX idx_pos_org      ON person_positions (org_id, relationship_type, is_current) WHERE valid_to IS NULL;
-- idx_pos_org powers "who works at Sage" (and "who founded Sage") — the reverse traversal.
```

**Rows for the example:**
```
person_id     org_id        relationship_type   title              is_current
pn_01ALEX…    org_01SAGE…   employee            Software Engineer  true
pn_01SIYA…    org_01SAGE…   employee            Product Manager    true
```
"Who else works at Sage?" = `SELECT person_id FROM person_positions WHERE org_id='org_01SAGE…' AND relationship_type='employee' AND is_current`. Returns Alex and Siya.

---

## 4. Domain B — `person_educations` (studied-at), upgraded to an org FK

The person doc stored `school_name` as free text. Here it gains `org_id` (the resolved school, an `organizations` row with `org_kind='school'`) while keeping `school_name` as raw-seen. Now "studied at" is a real edge into the same organization graph companies live in — so "alumni of SPPU who work at ERP builders" becomes one join.

```sql
CREATE TABLE person_educations (
    education_id      TEXT PRIMARY KEY,                  -- edu_<ULID>
    person_id         TEXT NOT NULL REFERENCES persons(person_id),
    org_id            TEXT REFERENCES organizations(org_id),   -- resolved school; NULL until resolved
    school_name       TEXT NOT NULL,                     -- as-seen, for audit
    relationship_type TEXT NOT NULL DEFAULT 'student',   -- 'student' today; alumnus is DERIVED (ended_year passed), never asserted
    degree            TEXT,                              -- "B.Tech", "MBA"
    fields_of_study   TEXT[],
    started_year      SMALLINT,
    ended_year        SMALLINT,
    -- provenance block
    source_id         TEXT NOT NULL REFERENCES sources(source_id),
    confidence        NUMERIC(4,3) NOT NULL,
    valid_from        TIMESTAMPTZ NOT NULL,
    valid_to          TIMESTAMPTZ,
    recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_edu_person ON person_educations (person_id) WHERE valid_to IS NULL;
CREATE INDEX idx_edu_org    ON person_educations (org_id, relationship_type) WHERE valid_to IS NULL;
-- idx_edu_org powers "who are the alumni of SPPU".
```

**Rows for the example:**
```
person_id     org_id        school_name                          degree
pn_01ALEX…    org_01SPPU…   Savitribai Phule Pune University      B.Tech
pn_01SIYA…    org_01DPU…    Dr. D. Y. Patil Vidyapeeth           B.E.
```

**Why keep employment and education as two tables** rather than one `person_org_relations` with a type? Because they carry genuinely different columns — education has `degree`/`fields_of_study`/`started_year`; employment has `title`/`job_function`/`seniority`/`is_current`. Forcing them into one table would NULL half the columns on every row (the exact anti-pattern the technology doc rejected for skills-vs-technologies). They *share the substrate* (person → organization) but *specialize the payload*. A `UNION` view gives you the combined "all of Alex's org affiliations" when you want it (file `05`).

The research pass found this split **unanimous** across providers: Crunchbase ships `jobs.csv` and `degrees.csv` as separate collections with disjoint payloads (`job_type`/`title` vs `degree_type`/`subject`); PDL separates `experience[]` from `education[]` (education carrying `degrees`/`majors`/`minors`/`gpa`); Diffbot separates `employments[]` (title, categories) from `educations[]` (degree object, major). No surveyed provider uses a generic person↔org edge. Two documented failure modes reinforce the payload choices here: Clearbit's current-employment-only model (no history array) is repeatedly cited as a competitive gap — history-keeping is the norm this schema follows — and PDL's non-persistent resolved IDs are why `school_name` stays on the row beside `org_id`.

**Why does "alumnus" not exist as a type?** Because it's a *function of the dates*: `ended_year < current year` ⇒ alumnus. Diffbot models it as `isCurrent` on the education edge; Crunchbase as `completed_on`. Asserting alumnus as a stored type means every graduation silently invalidates a stored value — derivable state that drifts. The `alumni_of` query (file `05` §2) is a date predicate, not a type filter.

---

## 5. Optional convenience — `person_org_affiliations` view (both domains, one read)

When you want "every institution Alex is connected to, however," union the two:

```sql
CREATE VIEW person_org_affiliations AS
  SELECT person_id, org_id, 'employment' AS domain, relationship_type,
         title AS detail, started_on::text AS started, is_current
  FROM person_positions WHERE valid_to IS NULL
  UNION ALL
  SELECT person_id, org_id, 'education' AS domain, relationship_type,
         degree AS detail, started_year::text AS started, NULL AS is_current
  FROM person_educations WHERE valid_to IS NULL;
```
This is a *read convenience*, not a storage table — the truth stays in the two specialized tables.

---

## 6. Node/edge summary for this file

```
persons ──person_positions[employee|founder|…]──▶ organizations(org_kind=company)
persons ──person_educations[student]────────────▶ organizations(org_kind=school)
```
Both edges land in ONE `organizations` table. Next file wires organizations to technologies.
