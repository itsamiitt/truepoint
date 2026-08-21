# CASCADE person-layer database architecture

Companion to the propagation-schema, category-system, and capture/storage docs. This adds the layer those deliberately left out: people. It is designed from the two uploaded Sales Navigator payloads (which define the shape of the data — multi-email with per-email source, multi-position with company references and dates, multi-education, ~60 skills with endorsement counts, languages) and from the requirements stated: multiple phones, company numbers, multiple professional *and* personal emails, multiple employment history rows, multiple skills and company technologies, billions-scale, API-key access, and differentiation from incumbents.

Provenance convention as before: plain prose restates established decisions; **[NEW]** marks design added here.

---

## 0. The strategic flag that comes before any DDL

The existing strategy is explicit that the owned base is company-level with **no person-level contact data** — person contacts are the paid Enrich zone, sourced per-request from Apollo/PDL/Coresignal into a *tenant-scoped* ledger. This document's requirement (a person database with multiple personal emails and phones) changes that posture, and there are exactly two coherent ways to hold it:

- **Option A — shared person base.** One canonical person store, populated ahead of demand, served to all tenants (the ZoomInfo/Apollo model). Maximum product surface; maximum cost, compliance exposure, and the largest departure from the current strategy docs.
- **Option B — tenant-materialized person store (recommended default).** The *schema below is identical*, but rows are written only when an enrich action fires; the shared base keeps identity-level position facts (who works where, title, function — buildable from open/licensed firmographic sources) while contact points live under tenant entitlement. This preserves the credit discipline as a storage principle, not just a paywall, and it matches the tested access pattern: identity free, contacts gated.

The design below works unchanged for either; the choice is *where rows come from and who may read them*, enforced in §6. Decide A vs. B consciously — it moves the cost model, the compliance surface, and the pitch. **[NEW]**: recommendation is B at launch with the schema leaving A open.

One more flag, stated once because your own risk register already states it: the uploaded payloads are LinkedIn Sales Navigator responses, and the existing business plan explicitly lists LinkedIn-style scraping ToS exposure (the Apollo March-2025 precedent) as a legal risk to avoid, preferring licensed providers and open registries. The schema below is therefore **source-agnostic**: it ingests the *shape* of that data from any licensed provider (PDL/Coresignal export the same structures contractually), and every contact row carries its source and license class so the compliance layer (§7) can act on it. Nothing in this document should be read as a recommendation to populate it by scraping LinkedIn.

---

## 1. Entity model at a glance

```
companies (existing) ──┬─ company_contact_points     (company phone numbers, generic emails)
                       ├─ company_technologies       (multi, first/last seen — technographics)
                       └─ facilities, company_edges, events, signals … (existing)

persons ──┬─ person_identifiers      (external IDs across sources — the ER backbone)
          ├─ person_positions        (employment history, multi, FK → companies)
          ├─ person_educations       (multi)
          ├─ person_skills           (multi, FK → skills taxonomy)
          ├─ person_emails           (multi, typed professional/personal)
          ├─ person_phones           (multi, typed)
          ├─ person_languages        (multi)
          └─ contact_attestations    (every independent sighting of every contact point)

skills                    (normalized taxonomy shared by persons and job postings)
tenant_enrichment_ledger  (existing concept, formalized — the entitlement gate)
api_keys / api_key_scopes (the access layer)
suppression_list          (compliance)
```

The design rule that keeps this manageable at billions of rows: **the `persons` row is slim; everything multi-valued is a child table; everything analytical or historical is a projection.** The uploaded payloads also demonstrate what *not* to store canonically — signed CDN image URLs with embedded expiry tokens (`e=1787184000&t=…`) are dead weight that rots; the raw payload belongs in the Iceberg lake per the capture doc, and only durable, structured facts get extracted into these tables.

---

## 2. Core DDL

All IDs are prefixed ULIDs per the existing convention (`pn_`, `pos_`, `em_`, `ph_`, `sk_`, `att_`, `key_`). All child tables carry per-row `source_id`, `confidence`, and bitemporal columns, extending the per-field provenance standard to per-*value* provenance — which is exactly what multi-valued attributes require.

### 2.1 Persons — slim identity core

```sql
CREATE TABLE persons (
    person_id          TEXT PRIMARY KEY,               -- pn_<ULID>
    full_name          TEXT NOT NULL,
    first_name         TEXT,
    last_name          TEXT,
    headline           TEXT,                             -- "Director @ …"
    summary            TEXT,                             -- long bio; candidate for TOAST/cold storage
    location_text      TEXT,
    country_code       CHAR(2),
    -- denormalized "current position" for the hot read path (see §5)
    current_company_id TEXT REFERENCES companies(company_id),
    current_title      TEXT,
    current_function   TEXT,                             -- normalized: finance | procurement | engineering | …
    current_seniority  TEXT,                             -- c_level | vp | director | manager | ic
    confidence         NUMERIC(4,3) NOT NULL,
    valid_from         TIMESTAMPTZ NOT NULL,
    valid_to           TIMESTAMPTZ,
    recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Citus: shard by hash(person_id); all person_* child tables colocated on person_id.
```

### 2.2 Identifiers — the entity-resolution backbone

Splink needs stable cross-source join keys. Every external identity a source exposes becomes a row here; the person merge/split history hangs off this table.

```sql
CREATE TABLE person_identifiers (
    identifier_id   TEXT PRIMARY KEY,
    person_id       TEXT NOT NULL REFERENCES persons(person_id),
    id_type         TEXT NOT NULL,      -- linkedin_member_urn | pdl_id | coresignal_id | flagship_url | email_hash
    id_value        TEXT NOT NULL,
    source_id       TEXT NOT NULL REFERENCES sources(source_id),
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id_type, id_value)
);
```

### 2.3 Employment history — multiple positions, resolved to canonical companies

The single most valuable structure in the payloads. Each position keeps the **raw company name as seen** *and* the resolved canonical `company_id` — raw for audit and re-resolution, canonical for the money join to signals.

```sql
CREATE TABLE person_positions (
    position_id       TEXT PRIMARY KEY,                 -- pos_<ULID>
    person_id         TEXT NOT NULL REFERENCES persons(person_id),
    company_id        TEXT REFERENCES companies(company_id),  -- NULL until Splink resolves
    company_name_raw  TEXT NOT NULL,
    title             TEXT NOT NULL,
    job_function      TEXT,                               -- normalized in extraction batch
    seniority         TEXT,
    description       TEXT,                               -- bullets from the payload; cold-storage candidate
    location_text     TEXT,
    started_on        DATE,                               -- month precision: store first-of-month
    ended_on          DATE,
    is_current        BOOLEAN NOT NULL DEFAULT false,
    source_id         TEXT NOT NULL REFERENCES sources(source_id),
    confidence        NUMERIC(4,3) NOT NULL,
    valid_from        TIMESTAMPTZ NOT NULL,
    valid_to          TIMESTAMPTZ,
    recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pos_person   ON person_positions (person_id) WHERE valid_to IS NULL;
CREATE INDEX idx_pos_company  ON person_positions (company_id, is_current) WHERE valid_to IS NULL;
-- idx_pos_company is THE index behind "who do I call at the affected company".
-- [NEW] Note: it targets the non-shard-key side; at scale this is the argument
-- for the ClickHouse projection in §5 carrying that read instead.
```

Job-change detection falls out of this table for free: a new `is_current` row at a different company, with the prior row's `ended_on` set, *is* the job-change signal incumbents sell — no extra machinery, just a query over what capture already writes. Employment history also back-fills the value-chain graph obliquely (a person moving between two firms is weak relationship evidence — the brainstorm doc's B9, low-confidence corroboration only).

### 2.4 Emails and phones — multiple, typed, verified, attested

Requirements said multiple professional *and* personal emails and multiple phones. The design principle: **one row per distinct value per person; every independent sighting is an attestation row.** Confidence then grows with independent corroboration — the same Noisy-OR philosophy the propagation engine uses, applied to contact data.

```sql
CREATE TABLE person_emails (
    email_id            TEXT PRIMARY KEY,               -- em_<ULID>
    person_id           TEXT NOT NULL REFERENCES persons(person_id),
    email_address       TEXT NOT NULL,                    -- lowercased, trimmed
    email_type          TEXT NOT NULL,                    -- professional | personal | unknown
    is_primary          BOOLEAN NOT NULL DEFAULT false,
    verification_status TEXT NOT NULL DEFAULT 'unverified',
        -- unverified → verified | catch_all | bounced | invalid  (SMTP-check lifecycle)
    last_verified_at    TIMESTAMPTZ,
    confidence          NUMERIC(4,3) NOT NULL,
    valid_from          TIMESTAMPTZ NOT NULL,
    valid_to            TIMESTAMPTZ,
    recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (person_id, email_address)
);

CREATE TABLE person_phones (
    phone_id            TEXT PRIMARY KEY,               -- ph_<ULID>
    person_id           TEXT NOT NULL REFERENCES persons(person_id),
    phone_e164          TEXT NOT NULL,                    -- normalized +<country><number>; raw kept in attestation
    phone_type          TEXT NOT NULL,                    -- mobile | direct_dial | switchboard | unknown
    is_primary          BOOLEAN NOT NULL DEFAULT false,
    verification_status TEXT NOT NULL DEFAULT 'unverified',
    last_verified_at    TIMESTAMPTZ,
    confidence          NUMERIC(4,3) NOT NULL,
    valid_from          TIMESTAMPTZ NOT NULL,
    valid_to            TIMESTAMPTZ,
    recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (person_id, phone_e164)
);

-- Every sighting of a contact value, from any source, forever.
CREATE TABLE contact_attestations (
    attestation_id   TEXT PRIMARY KEY,                  -- att_<ULID>
    contact_point_id TEXT NOT NULL,                       -- em_… or ph_… (soft reference; prefix routes)
    source_id        TEXT NOT NULL REFERENCES sources(source_id),
    raw_value        TEXT NOT NULL,                        -- exactly as the source gave it
    license_class    TEXT NOT NULL,                        -- inherited from capture envelope
    seen_at          TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_att_contact ON contact_attestations (contact_point_id, seen_at DESC);
```

**[NEW]** The attestation table is the differentiating structure here: it is what lets the product answer "*where did this phone number come from, when, from how many independent sources*" — the per-field-provenance trust promise extended to the data category where trust is worst in the market. A ZoomInfo record shows you a number; this schema can show its evidence.

Company numbers live on the company side, same pattern:

```sql
CREATE TABLE company_contact_points (
    contact_point_id  TEXT PRIMARY KEY,
    company_id        TEXT NOT NULL REFERENCES companies(company_id),
    kind              TEXT NOT NULL,          -- switchboard_phone | generic_email | fax
    value_normalized  TEXT NOT NULL,
    confidence        NUMERIC(4,3) NOT NULL,
    source_id         TEXT NOT NULL REFERENCES sources(source_id),
    valid_from        TIMESTAMPTZ NOT NULL,
    valid_to          TIMESTAMPTZ,
    UNIQUE (company_id, kind, value_normalized)
);
```

### 2.5 Skills and technologies — normalized taxonomies, link tables

The payload shows ~60 free-text skills per person. At billions of persons, storing "Healthcare Management" as a string per row is both wasteful and unqueryable ("find everyone with skill X" needs an ID, not a LIKE). Same argument the category system already made: **vocabulary tables + link tables.**

```sql
CREATE TABLE skills (
    skill_id      TEXT PRIMARY KEY,             -- sk_<ULID>
    name          TEXT NOT NULL UNIQUE,
    aliases       TEXT[],                          -- "EMR" ≈ "Electronic Medical Records"
    skill_kind    TEXT NOT NULL DEFAULT 'general'  -- general | technology | certification
);

CREATE TABLE person_skills (
    person_id        TEXT NOT NULL REFERENCES persons(person_id),
    skill_id         TEXT NOT NULL REFERENCES skills(skill_id),
    endorsement_count INTEGER,
    source_id        TEXT NOT NULL REFERENCES sources(source_id),
    recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (person_id, skill_id)
);
```

Company technologies are the existing technographics requirement, formalized to the same pattern — multi-valued with the first/last-seen timestamps the displacement-play USP depends on:

```sql
CREATE TABLE company_technologies (
    company_id    TEXT NOT NULL REFERENCES companies(company_id),
    skill_id      TEXT NOT NULL REFERENCES skills(skill_id),  -- skill_kind='technology'
    first_seen_at TIMESTAMPTZ NOT NULL,
    last_seen_at  TIMESTAMPTZ NOT NULL,
    detection_method TEXT,                     -- webappanalyzer | job_posting | self_declared
    confidence    NUMERIC(4,3) NOT NULL,
    source_id     TEXT NOT NULL REFERENCES sources(source_id),
    PRIMARY KEY (company_id, skill_id)
);
```

Sharing one taxonomy between person skills and company technologies is deliberate **[NEW]**: "companies whose stack includes Epic" and "people skilled in Epic" resolve to the same `skill_id`, which makes persona-matching queries ("procurement people at companies running SAP") a two-hop join instead of a string-matching problem.

### 2.6 Educations and languages

```sql
CREATE TABLE person_educations (
    education_id   TEXT PRIMARY KEY,
    person_id      TEXT NOT NULL REFERENCES persons(person_id),
    school_name    TEXT NOT NULL,
    school_ref     TEXT,                       -- external school URN/ID if the source had one
    degree         TEXT,
    fields_of_study TEXT[],
    started_year   SMALLINT,
    ended_year     SMALLINT,
    source_id      TEXT NOT NULL REFERENCES sources(source_id),
    recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE person_languages (
    person_id    TEXT NOT NULL REFERENCES persons(person_id),
    language     TEXT NOT NULL,
    proficiency  TEXT,                          -- elementary | professional | native_or_bilingual
    source_id    TEXT NOT NULL,
    PRIMARY KEY (person_id, language)
);
```

Volunteering, badges, pronunciation audio, connection counts, and the rest of the payload's long tail: **not modeled** at launch. They stay queryable in the raw lake; a table earns its DDL only when a product surface reads it. **[NEW]** deliberate scope cut.

---

## 3. How rows get here (capture integration)

Nothing new is invented — the person layer plugs into the pipeline the capture doc already defines. Raw provider payloads land in the Iceberg lake with a capture envelope (source, license_class, content hash); an extraction consumer parses the structured shape (no LLM needed for structured provider payloads — this is plain parsing; the LLM extractors remain for unstructured web text); Splink resolves persons across sources on `person_identifiers` + name/position blocking, and resolves each position's `company_name_raw` to a canonical `company_id`; the canonical writer inserts bitemporally behind the same confidence gate and review queue; Debezium CDC fans changes to the projections in §5. Enrich-triggered provider calls (STE `committed` state, Temporal workflow) follow the identical path with one addition: the ledger row and the credit debit in the same transaction boundary, per the capture doc.

---

## 4. Scale posture

Order-of-magnitude row counts if the base reaches ~1B persons **[NEW, placeholder math to size against reality]**: positions ~4–5B, skills links ~30–60B (the largest table in the system — the strongest argument for the taxonomy-ID design; a 16-byte-key link row is an order of magnitude cheaper than repeated strings), emails ~1.5–2.5B, attestations a few× that and append-only. Consequences:

- **Sharding**: hash(person_id) for `persons` and all `person_*` children (colocated single-shard reads for "everything about this person"); `companies` keeps its existing hash(company_id) scheme. The person↔company join crosses shard schemes by construction — accept it on the OLTP side for point lookups, and serve the heavy direction from a projection (below).
- **Postgres holds truth; ClickHouse holds the scan.** "All current finance people at these 40,000 companies" is a columnar scan, not an OLTP query. A `current_employment` projection in ClickHouse — `(company_id, person_id, function, seniority, title)`, ordered by company_id, rebuilt from CDC — carries the signal→people fan-out at feed scale. Same HTAP split already established for edges and signals.
- **Search and vector projections**: person-name resolution goes to OpenSearch/Typesense alongside company names; headline+summary embeddings go to Qdrant only if persona-semantic search becomes a product surface (defer — embedding a billion bios is a real cost, and function/seniority normalization covers most persona queries).
- **The skills link tables** are natural ClickHouse/lake residents once write patterns settle: append-mostly, scanned analytically, rarely point-read. **[NEW]** keep them in Postgres until measured pain, then move — the taxonomy IDs make the move trivial.
- **"Billions of users" serving reads**: the API layer never touches Postgres for feeds — feed cache + ClickHouse projections + read replicas for point lookups, exactly the read path the capture doc drew. Postgres write throughput is protected because the hot path writes (attestations, ledger, metering) are append-only inserts.

---

## 5. What NOT to store (learned directly from the uploads)

Signed CDN media URLs with expiry tokens; per-source UI artifacts (badge flags, `crmStatus`, `savedLead`, view counts); anything that is a *rendering* of the source platform rather than a fact about the person. These rot, bloat rows, and add zero query value. The raw payload in the lake preserves them for the day they matter; the canonical store holds only durable facts with provenance.

---

## 6. Access layer: STE zoning, entitlements, API keys

The zoning is now a property of the schema, not just the pricing page:

- **Scout zone (free, identity-level)**: `persons` minus nothing sensitive, `person_positions`, educations, skills, languages — who works where, doing what. Serviceable from open/licensed firmographic sources under Option B.
- **Enrich zone (credit-gated)**: `person_emails`, `person_phones`, and `contact_attestations`. Readable by a tenant only where a `tenant_enrichment_ledger` row exists.

```sql
CREATE TABLE tenant_enrichment_ledger (
    tenant_id     TEXT NOT NULL,
    person_id     TEXT NOT NULL REFERENCES persons(person_id),
    unlocked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    credit_txn_id TEXT NOT NULL,               -- FK to metering; same txn boundary as the debit
    provider_used TEXT,                          -- apollo | pdl | coresignal | owned_base
    PRIMARY KEY (tenant_id, person_id)
);
```

Enforcement is a LEFT JOIN against the ledger with contact columns nulled where no row exists — validated in this session's test: two tenants, one query shape, tenant A (unlocked) received the professional email and mobile number for the unlocked person, tenant B received `[locked]` for everything, and identity fields flowed free to both. In Postgres proper this becomes row-level-security policies plus API-layer masking rather than per-query CASE logic, but the semantics are what was tested.

API keys, per the /v1 conventions already specified (bearer keys with scopes, rate-limit tiering, usage metering):

```sql
CREATE TABLE api_keys (
    key_id         TEXT PRIMARY KEY,            -- key_<ULID>; the secret itself is NEVER stored
    tenant_id      TEXT NOT NULL,
    key_hash       TEXT NOT NULL,                 -- hash of the secret; compare-on-auth
    key_prefix     TEXT NOT NULL,                 -- first 8 chars, displayable ("csc_live_ab12…")
    name           TEXT,
    scopes         TEXT[] NOT NULL,               -- companies:read, persons:read, contacts:read,
                                                  -- contacts:enrich, signals:read, exports:write
    rate_limit_tier TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'active',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at   TIMESTAMPTZ,
    expires_at     TIMESTAMPTZ
);
```

`contacts:read` grants reading *already-unlocked* contact rows; `contacts:enrich` grants spending credits to unlock new ones — keeping a read-only integration key from silently burning budget. Every authenticated call writes to the existing `usage.metering` stream keyed by tenant. New /v1 surface implied: `GET /v1/persons/{id}`, `GET /v1/companies/{id}/people?function=&seniority=`, `POST /v1/persons/{id}/enrich` — all consistent with the existing prospects endpoints.

---

## 7. Compliance layer (non-optional once personal emails and phones exist)

Personal contact data is PII; the existing plan's GDPR/CCPA line item stops being "before EU entry" and starts being "before this table has rows" for any EU/California data subjects. **[NEW]** minimal machinery, designed now because retrofitting erasure onto a bitemporal store is miserable:

```sql
CREATE TABLE suppression_list (
    suppression_id  TEXT PRIMARY KEY,
    value_hash      TEXT NOT NULL UNIQUE,       -- salted hash of email/phone; never the value itself
    reason          TEXT NOT NULL,                -- erasure_request | opt_out | legal_hold_release
    requested_at    TIMESTAMPTZ NOT NULL
);
```

Rules: the capture pipeline checks the suppression hash *before* landing person-level values (suppressed values never re-enter, even from a new source); erasure requests cascade — contact rows and attestations for the subject are hard-deleted, lake copies of provider payloads containing them are handled per the provider retention terms captured as machine-readable `license_class` rules, and the bitemporal exception is explicit: **the right to erasure beats the append-only principle** for personal data, full stop. Each contact row's lawful basis rides on `license_class` + `source_id`, which is what makes "delete everything we hold from provider X" and "show the audit trail for this number" both single queries. This, plus the attestation evidence in §2.4, is a compliance posture incumbents cannot easily copy — their contact data mostly lacks per-value provenance to audit.

---

## 8. The differentiation question, answered honestly

The request asks for something "totally different" from existing sales-intelligence software. The honest engineering answer: **a person schema with multiple emails, phones, positions, and skills is not different — it is table stakes.** ZoomInfo, Apollo, and PDL all have exactly these structures; shipping them competently earns entry, not distinction. The differentiation lives in four places this architecture wires the person layer into, all of which are yours already and none of which incumbents have:

1. **Signals decide who to call.** Incumbents sell a directory you filter; this system's entry point is a *causal event* — the tested join runs signal → affected company → current people by function → contacts, so the contact record arrives already attached to a dated, explainable reason to reach out. The value-chain whitespace, extended one join further than any prior doc took it.
2. **Per-value evidence.** Attestations + verification lifecycle + freshness timestamps on every individual email and phone — provenance as a product surface, aimed at the exact trust collapse the market research documents.
3. **Credit discipline in the storage layer.** Scout/Enrich as schema zoning + ledger-gated reads, not a paywall bolted on top — Option B makes the cost model itself different from ahead-of-demand hoarders.
4. **One taxonomy across people and companies** (skills ≡ technologies), making persona-× -technographic targeting a join instead of a data-science project.

The pitch is not "our contact database is different"; it is "our contact database answers a question no one else's can even ask."

---

## 9. Open items

- **Option A vs. B (§0)** is the decision that gates everything else — cost model, compliance surface, and positioning all move with it.
- **Sourcing**: populate from licensed providers and open registries per the existing risk register; the SalesNav-shaped payloads define the schema, not the supply chain.
- **GDPR/CCPA counsel review** of §7 before the first personal-email row is written, not before EU expansion.
- **Placeholders to size against reality**: row-count math (§4), when skills links migrate to columnar, whether person embeddings ever ship.
- **Contact verification service** (SMTP checking, phone validation) is assumed but unspecified — a build-vs-buy decision with its own cost line.
- **Cross-shard join benchmark**: `idx_pos_company` on Postgres vs. the ClickHouse `current_employment` projection for the signal fan-out, on real volumes — same "benchmark before committing" rule as every other store decision.
