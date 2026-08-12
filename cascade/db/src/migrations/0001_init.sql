-- 0001_init.sql — CASCADE graph, greenfield DDL.
-- Source of truth: cascade-graph/schema/02–04. Hand-authored (never generated).
-- Portability substitutions (documented in cascade-graph/10-implementation-plan.md):
--   citext  → TEXT + lower() functional indexes (PGlite/test parity)
--   ltree   → dotted TEXT path + prefix LIKE (upgrade path to ltree noted)
-- Enums are TEXT + CHECK so vocabularies evolve without ALTER TYPE.

-- ───────────────────────── sources (04 §3) ─────────────────────────
CREATE TABLE sources (
    source_id     TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    source_type   TEXT NOT NULL CHECK (source_type IN ('licensed_provider','web_crawl','registry','manual')),
    license_class TEXT NOT NULL,
    reliability   NUMERIC(4,3) CHECK (reliability >= 0 AND reliability <= 1),
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────── organizations (02 §1) ─────────────────────────
CREATE TABLE organizations (
    org_id            TEXT PRIMARY KEY,
    org_kind          TEXT NOT NULL CHECK (org_kind IN ('company','school','nonprofit','government','other')),
    legal_name        TEXT NOT NULL,
    display_name      TEXT,
    primary_domain    TEXT,
    country_code      CHAR(2),
    employee_range    TEXT,
    founded_year      SMALLINT,
    company_type      TEXT,
    ticker            TEXT,
    institution_type  TEXT,
    confidence        NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    source_id         TEXT NOT NULL REFERENCES sources(source_id),
    valid_from        TIMESTAMPTZ NOT NULL,
    valid_to          TIMESTAMPTZ,
    recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_org_kind   ON organizations (org_kind) WHERE valid_to IS NULL;
CREATE INDEX idx_org_domain ON organizations (lower(primary_domain)) WHERE valid_to IS NULL;

-- ───────────── resolution substrate (02 §1b) ─────────────
CREATE TABLE organization_aliases (
    alias_id      TEXT PRIMARY KEY,
    org_id        TEXT NOT NULL REFERENCES organizations(org_id),
    alias         TEXT NOT NULL,
    alias_kind    TEXT NOT NULL DEFAULT 'trade' CHECK (alias_kind IN ('legal','trade','former_name','acronym','localized')),
    source_id     TEXT NOT NULL REFERENCES sources(source_id),
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, alias)
);
CREATE INDEX idx_org_alias_lookup ON organization_aliases (lower(alias));

CREATE TABLE organization_identifiers (
    org_id        TEXT NOT NULL REFERENCES organizations(org_id),
    id_type       TEXT NOT NULL CHECK (id_type IN ('domain','linkedin_slug','wikidata_qid','lei','crunchbase_uuid','duns')),
    id_value      TEXT NOT NULL,
    source_id     TEXT NOT NULL REFERENCES sources(source_id),
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id_type, id_value),
    UNIQUE (id_type, id_value)
);
CREATE INDEX idx_org_identifier_org ON organization_identifiers (org_id);

-- ───────────────────────── persons (02 §2) ─────────────────────────
CREATE TABLE persons (
    person_id          TEXT PRIMARY KEY,
    full_name          TEXT NOT NULL,
    first_name         TEXT,
    last_name          TEXT,
    headline           TEXT,
    location_text      TEXT,
    country_code       CHAR(2),
    current_org_id     TEXT REFERENCES organizations(org_id),
    current_title      TEXT,
    current_function   TEXT,
    current_seniority  TEXT,
    confidence         NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    valid_from         TIMESTAMPTZ NOT NULL,
    valid_to           TIMESTAMPTZ,
    recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_persons_current_org ON persons (current_org_id) WHERE valid_to IS NULL;

CREATE TABLE person_identifiers (
    person_id     TEXT NOT NULL REFERENCES persons(person_id),
    id_type       TEXT NOT NULL CHECK (id_type IN ('profile_url','email_hash','crunchbase_uuid','wikidata_qid')),
    id_value      TEXT NOT NULL,
    source_id     TEXT NOT NULL REFERENCES sources(source_id),
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (person_id, id_type, id_value),
    UNIQUE (id_type, id_value)
);
CREATE INDEX idx_person_identifier_person ON person_identifiers (person_id);

-- ─────────────── Domain A: person → org employment (02 §3) ───────────────
CREATE TABLE person_positions (
    position_id       TEXT PRIMARY KEY,
    person_id         TEXT NOT NULL REFERENCES persons(person_id),
    org_id            TEXT REFERENCES organizations(org_id),
    company_name_raw  TEXT NOT NULL,
    relationship_type TEXT NOT NULL DEFAULT 'employee'
        CHECK (relationship_type IN ('employee','founder','board_member','advisor','contractor','intern')),
    title             TEXT,
    job_function      TEXT,
    seniority         TEXT,
    description       TEXT,
    location_text     TEXT,
    started_on        DATE,
    ended_on          DATE,
    is_current        BOOLEAN NOT NULL DEFAULT false,
    source_id         TEXT NOT NULL REFERENCES sources(source_id),
    confidence        NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    valid_from        TIMESTAMPTZ NOT NULL,
    valid_to          TIMESTAMPTZ,
    recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pos_person ON person_positions (person_id) WHERE valid_to IS NULL;
CREATE INDEX idx_pos_org    ON person_positions (org_id, relationship_type, is_current) WHERE valid_to IS NULL;
-- One OPEN edge per (person, org, type); closed history may repeat (returnships).
CREATE UNIQUE INDEX uniq_pos_open ON person_positions (person_id, org_id, relationship_type) WHERE valid_to IS NULL;

-- ─────────────── Domain B: person → org education (02 §4) ───────────────
CREATE TABLE person_educations (
    education_id      TEXT PRIMARY KEY,
    person_id         TEXT NOT NULL REFERENCES persons(person_id),
    org_id            TEXT REFERENCES organizations(org_id),
    school_name       TEXT NOT NULL,
    relationship_type TEXT NOT NULL DEFAULT 'student' CHECK (relationship_type IN ('student')),
    degree            TEXT,
    fields_of_study   TEXT[],
    started_year      SMALLINT,
    ended_year        SMALLINT,
    source_id         TEXT NOT NULL REFERENCES sources(source_id),
    confidence        NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    valid_from        TIMESTAMPTZ NOT NULL,
    valid_to          TIMESTAMPTZ,
    recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_edu_person ON person_educations (person_id) WHERE valid_to IS NULL;
CREATE INDEX idx_edu_org    ON person_educations (org_id, relationship_type) WHERE valid_to IS NULL;

-- ─────────────── technology catalog (03 §1) ───────────────
CREATE TABLE technology_categories (
    category_id  TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    parent_id    TEXT REFERENCES technology_categories(category_id),
    path         TEXT NOT NULL UNIQUE   -- dotted materialized path, e.g. 'software.enterprise.erp'
);
CREATE INDEX idx_tech_cat_parent ON technology_categories (parent_id);

CREATE TABLE technologies (
    technology_id   TEXT PRIMARY KEY,
    canonical_name  TEXT NOT NULL,
    slug            TEXT UNIQUE NOT NULL,
    tech_kind       TEXT NOT NULL DEFAULT 'product' CHECK (tech_kind IN ('product','platform','service','library')),
    category_id     TEXT REFERENCES technology_categories(category_id),
    description     TEXT,
    is_saas         BOOLEAN,
    is_open_source  BOOLEAN,
    pricing_model   TEXT[],
    cpe23           TEXT,
    wikidata_qid    TEXT,
    confidence      NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    source_id       TEXT NOT NULL REFERENCES sources(source_id),
    valid_from      TIMESTAMPTZ NOT NULL,
    valid_to        TIMESTAMPTZ,
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uniq_tech_cpe23        ON technologies (cpe23) WHERE cpe23 IS NOT NULL;
CREATE UNIQUE INDEX uniq_tech_wikidata_qid ON technologies (wikidata_qid) WHERE wikidata_qid IS NOT NULL;

CREATE TABLE technology_aliases (
    alias_id      TEXT PRIMARY KEY,
    technology_id TEXT NOT NULL REFERENCES technologies(technology_id),
    alias         TEXT NOT NULL,
    alias_kind    TEXT NOT NULL DEFAULT 'variant' CHECK (alias_kind IN ('variant','former_name','detector_name','abbreviation')),
    source_id     TEXT NOT NULL REFERENCES sources(source_id),
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (technology_id, alias)
);
CREATE INDEX idx_tech_alias_lookup ON technology_aliases (lower(alias));

-- ─────────────── Domain C: org → technology (03 §2 — THE core table) ───────────────
CREATE TABLE org_technology_relations (
    rel_id             TEXT PRIMARY KEY,
    org_id             TEXT NOT NULL REFERENCES organizations(org_id),
    technology_id      TEXT NOT NULL REFERENCES technologies(technology_id),
    relationship_type  TEXT NOT NULL CHECK (relationship_type IN ('develops','uses','resells')),
    -- usage-specific (NULL for develops rows)
    first_seen_at      TIMESTAMPTZ,
    last_seen_at       TIMESTAMPTZ,
    detection_method   TEXT CHECK (detection_method IN ('webappanalyzer','job_posting','dns','self_declared')),
    detected_on_domain TEXT,
    -- develops-specific (NULL for uses rows)
    is_primary_product BOOLEAN,
    launched_on        DATE,
    source_id          TEXT NOT NULL REFERENCES sources(source_id),
    confidence         NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    valid_from         TIMESTAMPTZ NOT NULL,
    valid_to           TIMESTAMPTZ,
    recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One OPEN edge per (org, tech, type); closed history may repeat (re-adoption). 03 §2.
CREATE UNIQUE INDEX uniq_otr_open  ON org_technology_relations (org_id, technology_id, relationship_type) WHERE valid_to IS NULL;
CREATE INDEX idx_otr_org_type  ON org_technology_relations (org_id, relationship_type) WHERE valid_to IS NULL;
CREATE INDEX idx_otr_tech_type ON org_technology_relations (technology_id, relationship_type) WHERE valid_to IS NULL;
CREATE INDEX idx_otr_closed    ON org_technology_relations (technology_id, relationship_type, valid_to) WHERE valid_to IS NOT NULL;

-- ─────────────── Domain D: bitemporal ownership ledger (03 §3) ───────────────
CREATE TABLE technology_vendors (
    link_id       TEXT PRIMARY KEY,
    technology_id TEXT NOT NULL REFERENCES technologies(technology_id),
    org_id        TEXT NOT NULL REFERENCES organizations(org_id),
    relationship  TEXT NOT NULL CHECK (relationship IN ('creator','current_owner','former_owner')),
    source_id     TEXT NOT NULL REFERENCES sources(source_id),
    confidence    NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    valid_from    TIMESTAMPTZ NOT NULL,
    valid_to      TIMESTAMPTZ,
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tv_tech ON technology_vendors (technology_id, relationship) WHERE valid_to IS NULL;
CREATE INDEX idx_tv_org  ON technology_vendors (org_id, relationship) WHERE valid_to IS NULL;
-- The creator row is immutable and unique; exactly one OPEN current_owner at a time.
CREATE UNIQUE INDEX uniq_tv_creator       ON technology_vendors (technology_id) WHERE relationship = 'creator';
CREATE UNIQUE INDEX uniq_tv_current_owner ON technology_vendors (technology_id) WHERE relationship = 'current_owner' AND valid_to IS NULL;

-- ─────────────── Domain E: org ↔ org (01 Domain E) ───────────────
CREATE TABLE company_edges (
    edge_id           TEXT PRIMARY KEY,
    org_id_from       TEXT NOT NULL REFERENCES organizations(org_id),
    org_id_to         TEXT NOT NULL REFERENCES organizations(org_id),
    relationship_type TEXT NOT NULL CHECK (relationship_type IN ('supplies','buys_from','parent_of','subsidiary_of','competitor','partner')),
    source_id         TEXT NOT NULL REFERENCES sources(source_id),
    confidence        NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    valid_from        TIMESTAMPTZ NOT NULL,
    valid_to          TIMESTAMPTZ,
    recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (org_id_from <> org_id_to)
);
CREATE UNIQUE INDEX uniq_ce_open ON company_edges (org_id_from, org_id_to, relationship_type) WHERE valid_to IS NULL;
CREATE INDEX idx_ce_from ON company_edges (org_id_from, relationship_type) WHERE valid_to IS NULL;
CREATE INDEX idx_ce_to   ON company_edges (org_id_to, relationship_type) WHERE valid_to IS NULL;

-- ─────────────── attestations (04 §2 — the evidence log) ───────────────
CREATE TABLE relationship_attestations (
    attestation_id TEXT PRIMARY KEY,
    edge_table     TEXT NOT NULL CHECK (edge_table IN
        ('person_positions','person_educations','org_technology_relations','technology_vendors','company_edges')),
    edge_id        TEXT NOT NULL,
    source_id      TEXT NOT NULL REFERENCES sources(source_id),
    source_class   TEXT NOT NULL CHECK (source_class IN ('licensed_provider','web_public','registry','self_declared')),
    confidence     NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    raw_assertion  TEXT,
    seen_at        TIMESTAMPTZ NOT NULL,
    license_class  TEXT NOT NULL
);
CREATE INDEX idx_relatt_edge ON relationship_attestations (edge_table, edge_id, seen_at DESC);
