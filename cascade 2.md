# CASCADE Technology Entity Layer — Database Architecture Research & Design

*A living reference document to sit alongside CASCADE's existing architecture docs. Verified facts are cited to named sources; vendor-reported figures are flagged as such; estimates are marked explicitly.*

## TL;DR
- **Build a separate, first-class `technologies` table (tech_ ULID) rather than overloading the shared skills taxonomy.** The two concepts diverge sharply — technologies carry vendors, versions, pricing, and CPE/Wikidata keys; skills do not — so merging them forces NULL-heavy columns and ambiguous joins. Keep the shared `skills` taxonomy for person-skill tagging and bridge the two with an optional map table.
- **Split physical placement by row-count and access pattern.** The catalog, aliases, category tree, and bitemporal vendor links (low millions of rows, need referential integrity) live in Postgres/Citus; the massive company↔technology adoption edge table (realistically **tens of billions of rows** if you match BuiltWith-scale coverage — an estimate) belongs in ClickHouse as the analytical system of record, with a Debezium/Kafka current-state projection back into Postgres for OLTP lookups.
- **Do not build your own web-fingerprint detection at pre-seed.** Every commercial dataset (BuiltWith, HG Insights) contractually forbids raw redistribution; the only cleanly redistributable fingerprint ruleset is the GPL-3.0 Wappalyzer community fork (enthec/webappanalyzer), and GPL-3.0 copyleft carries real implications you must decide deliberately. For a chemicals/advanced-materials vertical, job-posting-derived signals will out-perform web fingerprinting, which mostly sees front-end martech.

## Key Findings

### How the incumbents model and source technographics
- **BuiltWith** is the scale leader. It claims, verbatim on its lead-generation page, *"124,423 technologies tracked over 41 years across nearly every single website on the Internet,"* and its own blog announced in April 2024: *"In early April 2024, we surpassed this incredible mark... tracking over 100,000 individual web technologies since our inception in 2007."* Public coverage figures cite **673M+ websites**. Detection is primarily web fingerprinting (HTML/JS/header signatures) plus DNS. Its dataset schema exposes a top-level `Category` plus a `SubCategories` array (two-level taxonomy), `FirstIndexed`/`LastIndexed`, `FirstAdded`, and ticker/exchange metadata identifying the vendor company.
- **HG Insights** covers **20,000+ products** and, per an April 2025 announcement, added *"an additional 10 million companies... bringing the total to 20 million tracked companies,"* with its RGI Fabric unifying *"over 20 billion market data points."* Its Data Quality & Methodology brief states that its AI-plus-human approach delivers *"technographic data that has an authenticated source and verified contextual sources, hence HG's 90% accuracy rate."* It deliberately avoids pure web-scraping, using multi-source AI analysis of job postings, contracts, and community signals to catch back-office/infrastructure systems that leave no web footprint, and offers a Time Series dataset going back roughly a decade.
- **TheirStack** (job-posting-based) states in its docs: *"We process over 320k jobs per day from 349k sources and track 33k technologies across 12M companies"* (marketing pages elsewhere cite ~13M companies and 33,000+ technologies). It uses a three-tier confidence model (low/medium/high) with first/last-seen dates per detection, and ships a three-file dataset (technographics, company profiles, technology catalog) in Parquet/CSV via S3. Strong on backend/data/DevOps; weaker on niche martech.
- **PredictLeads** tracks, per its blog, *"53,000+ technologies · 1.2+ billion technology adoptions detected since 2018 · 85 million websites with detected technologies"* (v3 docs now cite ~54,000 technologies and ~1.4 billion detections across 86M domains). Detections blend website footprints, DNS, IP ranges, job postings, integrations, and docs, each carrying first/last-seen, confidence, and explicit citations to the triggering evidence.
- **Datanyze** (owned by ZoomInfo since 2018) tracks ~30,000–35,000 technologies across ~35M businesses using 20+ methodologies, checked daily.
- **SimilarTech** (owned by Similarweb) crawls 300M+ websites; strong front-end/marketing detection, misses server-side.
- **Coresignal** sells technographic data on 3.5M+ companies (JSON flat file), sourced from its multi-source company dataset and job postings, with `first_verified_at`/`last_verified_at` per technology.
- **People Data Labs** launched technology data fields in mid-2026 as inference/proof-of-concept signals, not a mature catalog.
- **G2 Stack** (formerly Siftery) captures technologies across 70+ categories from a mix of automated methods and community contributions, with a product-usage timeline.
- **Wappalyzer** went closed-source in **August 2023**: the GitHub repo was deleted, the npm package deprecated, and the community-contributed GPL-3.0 fingerprint database was absorbed into its commercial product.

### Licensing & redistribution (critical for CASCADE's compliance discipline)
- **BuiltWith:** raw-data redistribution is prohibited; derived use inside your own product is permitted. Verbatim from its API terms: *"The only limitation is you cannot resell the data as-is or provide duplicate functionality to builtwith.com and its associated services."* Full legal text at builtwith.com/terms could not be independently fetched, but this operative clause is quoted on BuiltWith's own API docs and corroborated on its official Postman page.
- **HG Insights:** internal use only. Verbatim from its ToS Usage Restrictions clause: *"Customer may not sell, resell, license, sublicense, rent, publish, distribute, or make the Services or Content available, in whole or in part, to any third party unless otherwise expressly provided."* All Content (including derivatives) is reserved to HG. The often-cited "firmographics licensable but technographics restricted" nuance is not in the public ToS and would live in a negotiated order form.
- **TheirStack** and **PredictLeads:** redistribution terms are **NOT publicly retrievable** and are handled per-contract. TheirStack's Terms & Conditions page exists (theirstack.com/en/docs/legal/terms-and-conditions) but its body text could not be verified; PredictLeads publishes no public data-license page and its own blog advises buyers to *"confirm whether your license supports... any redistribution requirements."* **Confirm both with vendor legal in writing before ingesting into a redistributable product. Do not assume.**
- **Wappalyzer community forks (enthec/webappanalyzer, dochne/wappalyzer, tunetheweb/wappalyzer):** all **GPL-3.0**, confirmed via the actual LICENSE files (dochne carries the verbatim GPLv3 text; enthec's CONTRIBUTING states *"WebAppAnalyzer is an GPLv3 licensed, open source project written in JavaScript"*). The occasional blog claim that the ruleset is "MIT-licensed" is **wrong** for these forks (older, unrelated pre-2015 forks like developit/wappalyzer used MIT — likely the source of confusion). GPL-3.0 is strong copyleft: usable and redistributable, but derivative distributed works must also be GPL-3.0 with source available. enthec has publicly committed never to take the repo private.
- The enthec fingerprint JSON already carries the exact fields CASCADE needs: `cpe` (CPE 2.3 string), `oss` (boolean), `saas` (boolean), `pricing` (low/mid/high plus freemium/onetime/recurring/poa/payg), `description`, `implies`/`requires`/`excludes`, and `cats` (category IDs). This is a ready-made starter schema for the technology catalog.

### Technology entity modeling standards
- **CPE (NIST Common Platform Enumeration) 2.3** is the vulnerability-world standard: `cpe:2.3:<part>:<vendor>:<product>:<version>:<update>:<edition>:<lang>:<sw_edition>:<target_sw>:<target_hw>:<other>`, where `part` is a/h/o (application/hardware/OS). It natively encodes vendor→product→version, is public domain (not copyrighted in the US), and per NIST's NVD CPE API docs the dictionary contains *"1,632,075 CPE Names and more than 420,000 match strings."* Known weaknesses: naming inconsistencies for the same product, and entries are typically created only when a CVE is filed — so coverage of consumer/martech/SaaS/industrial software is thin. **Verdict: adopt CPE 2.3 as an optional external key on `technologies` where it exists, not as your primary key.**
- **Wikidata** models software as items with `instance of`, `subclass of`, plus developer/license properties; it holds 100M+ entities with stable QIDs. **Verdict: store the Wikidata QID as an optional external identifier for enrichment/reconciliation, not as a key.**
- **Bitemporal modeling** (valid time + transaction time) is the established pattern for exactly CASCADE's requirement — keeping a vendor/ownership link historically accurate across acquisitions. The canonical Martin Fowler example (a payroll rate changed retroactively, learned about later) maps directly onto "Technology X was created by Vendor A, which was acquired by Vendor B effective date D, recorded in our system on date R." Production bitemporal SQL stores (XTDB, Datomic) validate the substrate; CASCADE's valid_from/valid_to/recorded_at discipline already implements it.

### Scalability evidence
- **ClickHouse** routinely operates at tens-of-billions to trillions of rows. Its own LogHouse logging store *"holds over 19 PiB of logs (37 trillion rows) at six months' retention for its AWS regions alone,"* and a November 2025 follow-up reports it has since scaled to *"431 PiB... across 1.59 quadrillion rows."* Tesla ingested over **one quadrillion rows** in a load test; the public ClickPy dataset exceeds **2 trillion rows**; ClickHouse answered a **1-trillion-row** aggregation challenge in under 3 minutes for ~$0.56; and Altinity demonstrated ~1.34 bytes/row storage letting a trillion rows fit on a single VM. This comfortably covers a tens-of-billions-row adoption edge table.
- **Citus/Postgres** scales to **100+ node** production clusters processing billions of events/day with sub-second queries (Microsoft Learn/Citus docs), and Cybertec demonstrated 1 trillion rows in Citus columnar on a single PC. For CASCADE, the transactional catalog tables (millions of rows) are trivial for a single Citus coordinator; sharding matters only for the current-state adoption projection.
- **Sizing the edge table (estimate):** BuiltWith's 673M websites × dozens of detected technologies each implies **tens of billions of current detections**; a bitemporal/append-only history multiplies that further. This is the single design driver for placing the adoption edge in ClickHouse. If CASCADE stays chemicals-vertical only, the realistic near-term figure is far smaller (see Recommendations).

## Details

### 1. Provider-by-provider reference table

| Provider | Catalog size (self-reported) | Coverage (self-reported) | Detection method | Taxonomy | Redistribution |
|---|---|---|---|---|---|
| BuiltWith | 124,423+ techs | 673M+ sites | Web fingerprint + DNS | Category + SubCategories array (2-level) | No raw resale; derived use OK (quoted) |
| HG Insights | 20,000+ products | 20M companies | Multi-source AI (jobs, contracts, docs) | Product-based | Internal use only (quoted) |
| TheirStack | 33,000 techs | 12–13M companies | Job postings | Category catalog | Per-contract (UNVERIFIED) |
| PredictLeads | 53,000+ techs (~1.2–1.4B detections) | 85–86M domains | Multi-signal (web, DNS, IP, jobs) | Category | Per-contract (UNVERIFIED) |
| Datanyze | 30,000–35,000 techs | 35M businesses | 20+ methods | Category | ZoomInfo-owned |
| SimilarTech | — | 300M+ sites | Web fingerprint | Category | Similarweb-owned |
| Coresignal | ~2,000 (varies) | 3.5M companies | Multi-source + jobs | Category | Licensed dataset |
| StackShare / G2 Stack | 70+ categories | community | Self-declared + automated | Category | Community / G2 |
| People Data Labs | POC fields | 60M+ companies | Inference | — | Data license |
| Wappalyzer forks (enthec) | ~251 bundled to 2,500+ definitions | N/A (ruleset only) | Fingerprint ruleset | ~90 category IDs | GPL-3.0 (copyleft) |

*All catalog/coverage figures are vendor marketing claims, not audited numbers — treat as upper bounds. Accuracy/staleness criticism is common across all web-fingerprint providers: front-end bias, stale detections, and blindness to non-web-visible (backend/infrastructure) technologies. Job-posting providers (HG, TheirStack, PredictLeads) explicitly market themselves as fixing that gap.*

### 2. Recommended schema (DDL-level)

**Decision: separate first-class `technologies` table, NOT `skill_kind='technology'` rows in the shared taxonomy.** *(CASCADE-specific proposal, not an industry standard.)*

Reasoning: A skill (`sk_`) is an abstract competency attached to persons; a technology is a concrete product with a vendor, versions, pricing, licensing, and external keys. Overloading one table forces ~10+ technology-only columns to be NULL for every skill row and creates semantic ambiguity in joins and entity resolution. Keep the shared `skills` taxonomy for person-skill tagging; supersede the existing `company_technologies` link with `company_technology_adoptions` pointing at the new `technologies` table. Where a technology also implies a skill ("Kubernetes" the product vs. "Kubernetes administration" the competency), bridge them with an optional `technology_skill_map(technology_id, skill_id)`.

```sql
-- POSTGRES/CITUS (canonical, bitemporal, low-millions of rows)

CREATE TABLE technologies (
  technology_id     text PRIMARY KEY,          -- tech_ ULID
  canonical_name    text NOT NULL,
  slug              text UNIQUE NOT NULL,
  description       text,
  category_id       text REFERENCES technology_categories,
  is_open_source    boolean,                   -- from enthec 'oss'
  is_saas           boolean,                   -- from enthec 'saas'
  pricing_model     text[],                    -- enthec 'pricing' enum values
  cpe23             text,                       -- optional external key
  wikidata_qid      text,                       -- optional external key
  source_id         text NOT NULL,
  confidence        numeric(3,2) CHECK (confidence BETWEEN 0 AND 1),
  license_class     text NOT NULL,
  valid_from        timestamptz NOT NULL,
  valid_to          timestamptz,
  recorded_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE technology_aliases (
  alias_id          text PRIMARY KEY,          -- alias_ ULID
  technology_id     text NOT NULL REFERENCES technologies,
  alias             text NOT NULL,
  alias_type        text,                      -- rename | abbreviation | misspelling | locale
  source_id         text NOT NULL,
  confidence        numeric(3,2),
  valid_from        timestamptz NOT NULL,
  valid_to          timestamptz,
  recorded_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE technology_categories (
  category_id       text PRIMARY KEY,          -- cat_ ULID
  name              text NOT NULL,
  parent_id         text REFERENCES technology_categories,  -- adjacency-list tree
  path              ltree                       -- materialized path for fast subtree queries
);

-- Created-by / owned-by link, bitemporal for acquisitions & ownership changes
CREATE TABLE technology_vendors (
  link_id           text PRIMARY KEY,          -- tv_ ULID
  technology_id     text NOT NULL REFERENCES technologies,
  company_id        text NOT NULL,             -- co_ ULID -> canonical companies
  relationship      text NOT NULL,             -- 'creator' | 'current_owner' | 'former_owner'
  source_id         text NOT NULL,
  confidence        numeric(3,2),
  license_class     text NOT NULL,
  valid_from        timestamptz NOT NULL,      -- when this ownership became true
  valid_to          timestamptz,               -- closed when acquisition transfers ownership
  recorded_at       timestamptz NOT NULL DEFAULT now()
);

-- OPTIONAL at launch: versions (recommend deferring)
CREATE TABLE technology_versions (
  version_id        text PRIMARY KEY,          -- tver_ ULID
  technology_id     text NOT NULL REFERENCES technologies,
  version_string    text NOT NULL,
  release_date      date,
  cpe23             text,
  source_id         text NOT NULL,
  valid_from        timestamptz NOT NULL,
  valid_to          timestamptz,
  recorded_at       timestamptz NOT NULL DEFAULT now()
);
```

```sql
-- CLICKHOUSE (analytical system of record for the massive edge table)

CREATE TABLE company_technology_adoptions (
  company_id        String,                    -- co_ ULID
  technology_id     String,                    -- tech_ ULID
  first_seen_at     DateTime,
  last_seen_at      DateTime,
  detection_method  LowCardinality(String),    -- web_fingerprint | job_posting | dns | self_declared | integration
  confidence        Float32,
  source_id         String,
  license_class     LowCardinality(String),
  recorded_at       DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(recorded_at)
PARTITION BY toYYYYMM(first_seen_at)
ORDER BY (technology_id, company_id, detection_method);
```

**Physical placement rationale:**
- `technologies`, `technology_aliases`, `technology_categories`, `technology_vendors`, `technology_versions` → **Postgres/Citus.** Low-millions of rows, need FK integrity, bitemporal UPDATE-free discipline, and OLTP editing.
- `company_technology_adoptions` → **ClickHouse** (tens of billions of rows, estimate), append-only, with a `ReplacingMergeTree` collapsing to latest-recorded state.
- **Current-state projection in Postgres** via Debezium/Kafka: a slim `company_technology_current` (company_id, technology_id, last_seen_at, confidence) for fast per-company OLTP lookups, populated by CDC. *(This dual placement — OLTP catalog + OLAP edge with CDC projection — is an established industry pattern, matching CASCADE's existing Debezium projection discipline.)*

### 3. Handling acquisitions, renames, and aliases
- **Acquisition:** never mutate the creator link. When Vendor A (creator) is acquired by Vendor B, close A's `current_owner` row (`valid_to` = acquisition date) and insert a new `current_owner` row for B. The original `creator` row for A remains open-ended and untouched, preserving "who created it" forever. This is textbook bitemporal SCD-2 and directly satisfies the founder's "keep the created-by link historically accurate" requirement.
- **Rename/rebrand:** write a new bitemporal `technologies` row with the updated `canonical_name`, and add the old name to `technology_aliases` with `alias_type='rename'`.
- **Alias resolution:** use Splink (already in-stack) to resolve incoming technology name strings against `canonical_name` + `technology_aliases`. CPE vendor/product tokens and Wikidata QIDs serve as strong blocking keys.

### 4. Displacement signals & competitive queries
- **Displacement (tech X removed / tech Y added):** because the edge table is append-only and bitemporal, each company's technology timeline is reconstructable. A displacement signal is a `last_seen_at` for X closing within a window while a `first_seen_at` for Y opens — computed efficiently in ClickHouse with a windowed self-join or `groupArray`/`argMax` per company. Emit these as Kafka events for the sales-signal layer.
- **Competitive queries ("all companies using any technology created by vendor V"):** join `technology_vendors` (relationship='creator', filtered to company_id=V, evaluated bitemporally as-of a date) → `technologies` → `company_technology_adoptions`. The vendor link is precisely what turns a flat technographic lookup into a competitive-intelligence engine, and it is the differentiator most incumbents (which model only company→technology, not technology→vendor) do not expose cleanly.

## Recommendations

**Stage 1 (launch — next 1–2 sprints):**
1. Ship the Postgres/Citus catalog tables (`technologies`, `technology_aliases`, `technology_categories`, `technology_vendors`) exactly as above. **Defer `technology_versions`** — versions add significant cardinality and are not needed for adoption-based sales signals in a chemicals/materials vertical.
2. Seed the catalog from the **GPL-3.0 enthec/webappanalyzer** ruleset (it already carries description, CPE, oss/saas, pricing, categories) — but make the GPL-3.0 decision first (open items).
3. Stand up `company_technology_adoptions` in ClickHouse and the Debezium current-state projection in Postgres.

**Stage 2 (post-launch):**
4. Buy job-posting-derived technographics (TheirStack or PredictLeads) rather than building detection — better fit for non-web-visible industrial software and cheaper than a crawl fleet. Confirm redistribution terms in writing first.
5. Add CPE 2.3 and Wikidata QID enrichment as optional external keys and Splink blocking keys.

**Benchmarks/thresholds that change the plan:**
- If the adoption edge table stays under ~1–2 billion rows (i.e., you remain chemicals-vertical only), keep it in Citus columnar and skip ClickHouse for this table; revisit the ClickHouse decision at ~2B rows or when analytical query latency on Citus exceeds your SLA.
- If a customer needs version-level displacement (e.g., "SAP ECC → S/4HANA migrations"), promote `technology_versions` into launch scope.
- If you decide to distribute any software artifact embedding the fingerprint data, the GPL-3.0 question becomes blocking — resolve it before that release.

## Caveats
- All provider catalog/coverage figures are **self-reported marketing claims**, not independently audited; treat as upper bounds. The tens-of-billions edge-table sizing is a CASCADE **estimate** derived from BuiltWith's public site count, not a measured figure.
- **TheirStack and PredictLeads redistribution terms could not be verified from public sources** — obtain them in writing before ingesting into any redistributable CASCADE product.
- CPE coverage skews toward software with published CVEs; expect thin coverage of martech/SaaS/industrial-specific tools, which is why CPE should be an optional key, not the spine.
- GPL-3.0 copyleft on the fingerprint forks is a genuine legal decision, not a formality.

### Open items requiring the founder's decision
1. **GPL-3.0 acceptance.** Will CASCADE embed GPL-3.0 fingerprint data/derivations in a *distributed* product? If the catalog data is used only server-side (SaaS, not distributed as software), GPL-3.0's distribution triggers may not fire — but confirm with counsel. Alternative: treat enthec purely as a seed reference and rebuild your own catalog to avoid copyleft entanglement entirely.
2. **Build vs. buy detection.** Recommendation: **BUY** (job-posting technographics) at pre-seed. Building a crawl/fingerprint fleet is a major ops burden with front-end bias ill-suited to industrial verticals.
3. **Which paid dataset.** TheirStack (breadth, job-posting freshness) vs. PredictLeads (multi-signal, per-detection citations) vs. HG Insights (accuracy, back-office coverage, but strictest redistribution terms). Decide on redistribution terms and chemicals-vertical fit.
4. **Versions at launch.** Recommendation: **defer.**
5. **CPE/Wikidata as keys.** Recommendation: **optional external keys, not primary.**