-- 0101_technology_adoptions.sql — the company↔technology ADOPTION EDGE: the table that replaces
-- `master_companies.technographics`, an untyped jsonb blob that could not answer the primary technographic
-- question ("which companies use X"), carried no first/last-seen, no detection method, and no per-value
-- provenance (audit finding D1). EXPAND ONLY: created empty, the jsonb column is untouched and still
-- authoritative, and nothing reads this table until the repository and the dual-write land. Behaviour today
-- is unchanged.
--
-- HAND-AUTHORED because the table is PARTITIONED BY RANGE, which Drizzle cannot express. The Drizzle module
-- (schema/masterTechnologyAdoption.ts) is deliberately NOT re-exported from schema/index.ts, and
-- drizzle.config.ts points at that barrel — so `drizzle-kit generate` can never see this table and never
-- emits DDL for it. Exactly the provenanceEvent.ts / 0089 precedent.
--
-- WHY POSTGRES AND NOT A COLUMNAR STORE (the decision this table embodies)
-- The reference design put this edge in ClickHouse on a self-labelled ESTIMATE ("tens of billions of rows IF
-- you match BuiltWith-scale coverage") and set its own escape hatch at 1–2B rows. TruePoint has no crawl
-- fleet and is not building one — raw database-size expansion is non-goal S-05 — so coverage arrives via
-- licensed feeds and growth is bounded by what is bought. The PostgreSQL manual puts the real ceiling on
-- PARTITION COUNT, not row count: "The query planner is generally able to handle partition hierarchies with
-- up to a few thousand partitions fairly well." Monthly partitioning spends 12 per year.
-- Revisit trigger, written down so it is a measurement and not an argument: rows > 1.5B, OR p95 latency on
-- idx_tech_adoptions_technology above SLO for two consecutive weeks. No new datastore ships on an estimate.
--
-- WHY THERE IS NO UNIQUE ON (company, technology, method) — read before adding one
-- The grain is one row per DETECTION EPISODE, not one row per pair. A technology detected, later removed,
-- then detected again is THREE facts and must be three rows: collapsing them to one destroys the
-- displacement timeline, which is the entire reason this table exists (tech X closes while tech Y opens is
-- the signal). A unique on the pair would also silently absorb the partition key and become "one row per
-- pair per month" — the trap 0085 documents for provider_calls and 0089 for provenance_event.
-- Idempotency is an UPSTREAM contract, as everywhere else in this pipeline: source_records.content_hash is
-- UNIQUE and unpartitioned, so an identical payload never produces a second detection.
--
-- ACCESS MODEL: Layer 0 — system-owned, isolated by ACCESS PATH not RLS. No workspace_id exists to write a
-- fail-closed predicate over. leadwolf_app is REVOKE'd in applyMigrations.ts GRANTS; the table is named
-- master_* so the convention-based catch-all there revokes it even if the explicit list is forgotten.
--
-- Partitioned monthly on observed_at (VALID time — when the detection was true), not recorded_at. Rationale:
-- every read of this table is "what was true in window W", and a provider backfill that lands three years of
-- history on one day would pile the entire backfill into one recorded_at partition while leaving the months
-- it describes empty. The partition sweep is CATALOG-driven (partitionRepository asks pg_class for
-- relkind='p'), so this table is maintained automatically with no registry to update.

CREATE TABLE IF NOT EXISTS master_technology_adoptions (
  id                uuid NOT NULL DEFAULT uuid_generate_v7(),
  master_company_id uuid NOT NULL REFERENCES master_companies(id) ON DELETE CASCADE,
  technology_id     uuid NOT NULL REFERENCES master_technologies(id) ON DELETE CASCADE,
  -- HOW it was detected. Drives the confidence weight AND the decay half-life: research is explicit that
  -- decay logic varies by source type, and a DNS record and a job posting cannot share a half-life.
  detection_method  varchar(30) NOT NULL,
  first_seen_at     timestamptz NOT NULL,
  last_seen_at      timestamptz NOT NULL,
  -- Set when a detection stops being observed. NULL while live. This column IS the displacement signal.
  removed_at        timestamptz,
  confidence        numeric(4,3),
  source_count      integer NOT NULL DEFAULT 1,   -- independent corroboration (survivorship input)
  source_name       varchar(50),
  -- LINEAGE into the shipped evidence log — the "show me why you think this" link. SET NULL, not CASCADE,
  -- for the reason 0089 gives: retention may reap a source_record and the detection must outlive its payload.
  evidence_ref      uuid REFERENCES source_records(id) ON DELETE SET NULL,
  observed_at       timestamptz NOT NULL,          -- VALID time; PARTITION KEY
  recorded_at       timestamptz NOT NULL DEFAULT now(),  -- TRANSACTION time
  PRIMARY KEY (id, observed_at),
  CONSTRAINT master_technology_adoptions_method_enum CHECK (detection_method IN
    ('web_fingerprint','job_posting','dns','self_declared','integration','filing','manual')),
  CONSTRAINT master_technology_adoptions_confidence_range CHECK (
    confidence IS NULL OR confidence BETWEEN 0 AND 1),
  CONSTRAINT master_technology_adoptions_source_count_positive CHECK (source_count >= 1),
  -- A detection cannot stop being seen before it started.
  CONSTRAINT master_technology_adoptions_last_after_first CHECK (last_seen_at >= first_seen_at),
  -- Removal cannot precede the last sighting.
  CONSTRAINT master_technology_adoptions_removed_after_last CHECK (
    removed_at IS NULL OR removed_at >= last_seen_at)
) PARTITION BY RANGE (observed_at);
--> statement-breakpoint

-- Months FIRST, then the catch-all (the 0085/0089 ordering rationale): a row sitting in the DEFAULT partition
-- blocks a later CREATE ... PARTITION OF for that month outright. The default is belt-and-braces — if the
-- sweep ever stops, writes land there instead of failing on the 1st.
SELECT ensure_month_partitions('master_technology_adoptions'::regclass, 3);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS master_technology_adoptions_default
  PARTITION OF master_technology_adoptions DEFAULT;
--> statement-breakpoint

-- THE QUERY THE JSONB BLOB COULD NOT ANSWER: "which companies use technology X, most recently seen first".
-- Created on the parent so it propagates to every partition, existing and future.
CREATE INDEX IF NOT EXISTS idx_tech_adoptions_technology
  ON master_technology_adoptions (technology_id, last_seen_at DESC);
--> statement-breakpoint
-- The company-profile read: "what does this company run".
CREATE INDEX IF NOT EXISTS idx_tech_adoptions_company
  ON master_technology_adoptions (master_company_id, technology_id);
--> statement-breakpoint
-- The displacement scan: recently-removed detections. Partial — live detections are the overwhelming
-- majority and are never looked up this way, so the index stays a small fraction of the table.
CREATE INDEX IF NOT EXISTS idx_tech_adoptions_removed
  ON master_technology_adoptions (removed_at DESC, technology_id)
  WHERE removed_at IS NOT NULL;

-- DOWN (manual — safe at any point before the dual-write lands, since nothing reads the table):
--   DROP TABLE master_technology_adoptions CASCADE;
