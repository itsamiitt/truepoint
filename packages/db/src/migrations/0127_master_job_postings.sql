-- 0127_master_job_postings.sql — the Layer-0 hiring-intelligence evidence table [S-02][S-13][A-01]
-- (HAND-AUTHORED, additive-only; docs/planning/market-intelligence/06-architecture.md MI-S1. PARTITION BY
-- HASH is not expressible by drizzle-kit; schema/masterJobPostings.ts is kept OUT of schema/index.ts —
-- the masterHeadcount/masterSignals pattern).
--
-- WHY THIS TABLE EXISTS: before it, "who is hiring for X role" was unanswerable — job_posting_surge /
-- key_role_opened were signal codes with no producer, and detection_method='job_posting' on
-- master_technology_adoptions had no evidence table behind it (02-gap-analysis). This is the fact store;
-- surge SIGNALS stay in master_signals (fact + dated event, the funding/headcount precedent).
--
-- WHY HASH(master_company_id), 32 partitions — the 0114 reasoning verbatim: upsert identity must live in
-- a partitioned unique, every first feed sync backfills history (RANGE-on-date would land it in DEFAULT),
-- and every hot read is per-company. Dedup identity = (master_company_id, source_name, canonical_url):
-- one row per posting per source, refreshed in place (last_seen_at/closed_at move; a posting is state,
-- not an event).
--
-- COMPLIANCE (09 rule 3 / market-intelligence 08 §1): a posting row carries ORGANIZATION facts only.
-- There are deliberately NO recruiter/contact columns, and the feed parser strips person names, emails
-- and phones at landing — silver-stage guard, before this table ever sees the row.
--
-- PRODUCER: none yet — gated on the D-6 licensed-postings-feed procurement (decisions.md 2026-08-19).
-- The writer ships so the feed lands with schema, grants and reads already proven (the
-- master_company_funding posture).
--
-- ACL: ^master_ REVOKE convention loop + leadwolf_er parent grant in applyMigrations.ts +
-- mirror_partition_acl for the partitions.

CREATE TABLE IF NOT EXISTS master_job_postings (
  id                uuid NOT NULL DEFAULT uuid_generate_v7(),
  master_company_id uuid NOT NULL REFERENCES master_companies(id) ON DELETE CASCADE,
  source_name       varchar(50) NOT NULL,
  canonical_url     varchar(500) NOT NULL,
  title             varchar(300) NOT NULL,
  department        varchar(100),
  seniority_level   varchar(20),
  location          varchar(200),
  posted_at         date,
  closed_at         date,
  evidence_ref      uuid,
  observed_at       timestamptz NOT NULL,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT master_job_postings_pk PRIMARY KEY (master_company_id, source_name, canonical_url),
  CONSTRAINT master_job_postings_seniority_enum CHECK (
    seniority_level IS NULL OR seniority_level IN ('c_suite','vp','director','manager','ic','other')
  ),
  CONSTRAINT master_job_postings_dates_sane CHECK (closed_at IS NULL OR posted_at IS NULL OR closed_at >= posted_at)
) PARTITION BY HASH (master_company_id);
--> statement-breakpoint
DO $$
DECLARE i int;
BEGIN
  FOR i IN 0..31 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS master_job_postings_p%s PARTITION OF master_job_postings
         FOR VALUES WITH (MODULUS 32, REMAINDER %s)',
      lpad(i::text, 2, '0'), i
    );
  END LOOP;
END $$;
--> statement-breakpoint
-- The open-roles read (company page + "hiring for X in dept Y"): per-company, open rows only.
CREATE INDEX IF NOT EXISTS idx_master_job_postings_open
  ON master_job_postings (master_company_id, posted_at DESC)
  WHERE closed_at IS NULL;
