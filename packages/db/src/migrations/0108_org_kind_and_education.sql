-- 0108_org_kind_and_education.sql — the re-planned graph: institutions are one kind of node, and
-- "studied at" is a first-class typed edge alongside "works at".
--
-- HAND-AUTHORED (drizzle-kit generate is unsafe against this snapshot chain — see 0101/0103 headers).
-- Layer 0: system-owned, no tenant column, isolated by ACCESS PATH (leadwolf_er) not RLS. The
-- `^master_` REVOKE convention loop in applyMigrations.ts covers master_education automatically.
--
-- Three changes, in dependency order:
--   1. master_companies gains org_kind    — a school is an organization, not a separate subsystem.
--   2. master_education is created        — the person→organization edge that had NOWHERE to live.
--   3. master_companies.technographics    — DROPPED. Superseded by master_technology_adoptions (0101).
--
-- WHY ONE ORGANIZATION TABLE (and not a master_schools sibling): "Alex works at Sage" and "Alex
-- studied at SPPU" are the same SHAPE of fact — a person bound to an institution with a role and
-- dates. A parallel school table would fork entity resolution, provenance, and every traversal.
-- Diffbot resolves employer AND institution to one Organization type; Crunchbase points degrees at
-- the same organizations collection. This follows that, and it makes a professor at SPPU just an
-- ordinary master_employment row pointing at a school — no third subsystem.
--
-- ADDITIVE AND REVERSIBLE for 1 and 2 (new column with a default, new table). Change 3 drops a
-- column that is provably dead: a repo-wide grep finds its schema line and doc comments only —
-- no reader, no writer, and master_technology_adoptions is the real store. Down migration at the
-- foot of this file.

-- ── 1. Institutions get a kind ────────────────────────────────────────────────────────────────
-- DEFAULT 'company' backfills every existing row to exactly what it already is, so this is a
-- metadata-only rewrite in PG11+ and no existing query changes meaning.
ALTER TABLE master_companies
  ADD COLUMN IF NOT EXISTS org_kind VARCHAR(20) NOT NULL DEFAULT 'company';

ALTER TABLE master_companies
  DROP CONSTRAINT IF EXISTS master_companies_org_kind_enum;
ALTER TABLE master_companies
  ADD CONSTRAINT master_companies_org_kind_enum
  CHECK (org_kind IN ('company','school','nonprofit','government','other'));

-- Schools are a small minority of rows; every "list the schools" read is a filtered scan that
-- would otherwise walk the whole company table.
CREATE INDEX IF NOT EXISTS idx_master_companies_org_kind
  ON master_companies (org_kind)
  WHERE org_kind <> 'company';

-- ── 2. The education edge ─────────────────────────────────────────────────────────────────────
-- Deliberately a SEPARATE table from master_employment rather than a shared person→org table with
-- a type discriminator: the payloads genuinely differ (degree/fields/years vs title/seniority/
-- is_primary), and merging them would NULL half the columns on every row. Every provider surveyed
-- (Crunchbase jobs/degrees, PDL experience/education, Diffbot employments/educations) splits them
-- the same way. They share the SUBSTRATE (person → master_companies), not the payload.
CREATE TABLE IF NOT EXISTS master_education (
    id                       UUID NOT NULL DEFAULT uuid_generate_v7(),
    master_person_id         UUID NOT NULL REFERENCES master_persons(id) ON DELETE CASCADE,
    -- NULLABLE for the same reason master_employment.master_company_id is (0105): an education
    -- assertion whose school has not yet resolved must still be recordable, or the fact is lost at
    -- the door. The raw name below carries it until ER catches up.
    master_company_id        UUID REFERENCES master_companies(id) ON DELETE CASCADE,
    -- The school name EXACTLY as the source gave it — the audit trail for the match, and the input
    -- to any future re-resolution. Retained after resolution, never overwritten.
    school_name_raw          VARCHAR(255),
    -- Written by the SAME TypeScript normalizer that computes master_companies.name_normalized.
    -- One implementation, stored — two implementations of "normalize an institution name" WILL drift.
    school_name_normalized   CITEXT,
    -- ── education facts ──
    degree                   VARCHAR(120),
    fields_of_study          TEXT[],
    started_on               DATE NOT NULL DEFAULT '-infinity',
    ended_on                 DATE,
    -- NOTE: there is deliberately NO `is_alumnus` column. Alumnus status is DERIVED from ended_on
    -- (a date in the past). Storing it would mean every graduation silently invalidates a stored
    -- value. Diffbot models it as isCurrent; Crunchbase as completed_on. Same call here.
    -- ── derived provenance cache (TRUTH stays source_records + match_links) ──
    asserting_source         VARCHAR(50),
    match_method             VARCHAR(20),
    confidence               NUMERIC(4,3),
    source_count             INTEGER NOT NULL DEFAULT 1,
    observed_at              TIMESTAMPTZ,
    last_verified_at         TIMESTAMPTZ,
    field_provenance         JSONB NOT NULL DEFAULT '{}'::jsonb,
    prov_hwm                 TIMESTAMPTZ,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT master_education_pkey PRIMARY KEY (id),
    CONSTRAINT master_education_confidence_range
      CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
    CONSTRAINT master_education_ended_after_started
      CHECK (ended_on IS NULL OR ended_on >= started_on),
    -- At least one way to identify the institution, or the row is unusable.
    CONSTRAINT master_education_institution_present
      CHECK (master_company_id IS NOT NULL OR school_name_raw IS NOT NULL)
);

-- One stint per (person, school, start). '-infinity' as the start sentinel makes two "start
-- unknown" assertions COLLIDE and dedup rather than accumulate — the same trick
-- uniq_employment_stint uses.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_education_stint
  ON master_education (master_person_id, master_company_id, started_on)
  WHERE master_company_id IS NOT NULL;

-- Unresolved stints cannot use the index above (NULLs are distinct), so they get a best-effort
-- partial unique on the normalized raw name — the same cover 0105 added for employment.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_education_unresolved_stint
  ON master_education (master_person_id, school_name_normalized, started_on)
  WHERE master_company_id IS NULL AND school_name_normalized IS NOT NULL;

-- "Where did this person study" — the person-profile read.
CREATE INDEX IF NOT EXISTS idx_master_education_person
  ON master_education (master_person_id, ended_on DESC NULLS FIRST);

-- "Who are the alumni of this school" — the reverse traversal. ended_on is in the key because the
-- alumni-vs-current split is a date predicate, not a stored flag.
CREATE INDEX IF NOT EXISTS idx_master_education_school
  ON master_education (master_company_id, ended_on DESC)
  WHERE master_company_id IS NOT NULL;

-- The ER backfill work queue: assertions still waiting on a resolved school.
CREATE INDEX IF NOT EXISTS idx_master_education_unresolved
  ON master_education (school_name_normalized)
  WHERE master_company_id IS NULL;

-- ── 3. Drop the superseded blob ───────────────────────────────────────────────────────────────
-- master_companies.technographics was the first-draft store for "what does this company run". It
-- has NO writer and NO reader anywhere in the repo (its own schema comment says so), and
-- master_technology_adoptions (0101) is the real, queryable model with per-detection grain,
-- method, and displacement. Carrying a dead column that LOOKS like the answer is a trap for the
-- next reader.
ALTER TABLE master_companies DROP COLUMN IF EXISTS technographics;

-- ── DOWN (manual; this project's convention is forward-only, recorded for the incident case) ──
-- ALTER TABLE master_companies ADD COLUMN technographics JSONB NOT NULL DEFAULT '{}'::jsonb;
-- DROP TABLE IF EXISTS master_education;
-- DROP INDEX IF EXISTS idx_master_companies_org_kind;
-- ALTER TABLE master_companies DROP CONSTRAINT IF EXISTS master_companies_org_kind_enum;
-- ALTER TABLE master_companies DROP COLUMN IF EXISTS org_kind;
