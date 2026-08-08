-- 0103_master_signals.sql — the canonical market/company SIGNAL store (Group C).
-- EXPAND ONLY: two new tables plus their reference vocabulary. `intent_signals` is NOT touched, NOT migrated,
-- and NOT deprecated — it remains the correct home for tenant-private engagement scoring. Behaviour today is
-- unchanged.
--
-- WHAT IS WRONG TODAY (audit D6)
-- `intent_signals` is tenant_id + workspace_id + contact_id scoped, with a CLOSED 9-value CHECK enum. Three
-- separate problems fall out of that: (a) a canonical market fact ("Acme raised a Series B") is not tenant
-- data and has nowhere to live, so the same fact is re-derived per tenant or not stored at all; (b) every new
-- signal family is a migration; (c) the table is contact-scoped, so a COMPANY-level signal cannot be attached
-- at all. This migration fixes all three without moving a single existing row.
--
-- WHY A LOOKUP TABLE INSTEAD OF A CHECK ENUM
-- The vocabulary is the thing most expected to grow, and a CHECK enum makes growth a schema change with a
-- deploy behind it. master_signal_types is reference data: adding "seed_round" or "office_opening" is an
-- INSERT. It also gives each type somewhere to carry its own weight and DECAY HALF-LIFE, which research says
-- must vary by type — a funding round stays true indefinitely, a hiring surge decays in weeks.
--
-- WHAT IS DELIBERATELY ABSENT: THE 'intent' FAMILY
-- Six signal families are industry-standard. Five of them (hiring, funding/M&A, tech-stack change, leadership
-- change, filings) are COMPANY FACTS and are in scope. The sixth — intent/content-engagement, i.e. tracking
-- what individuals read — is deferred non-goal X-04 in docs/strategy/04-opportunity-scores.md, and it is also
-- the family carrying by far the heaviest privacy weight. The family CHECK below has no 'intent' value, so
-- adding it is a deliberate migration and a deliberate decision, not an INSERT someone makes on a Friday.
--
-- SUBJECT IS POLYMORPHIC AND HAS NO FK — deliberately, and precedented
-- (subject_type, subject_id) addresses either a company or a person, so no single FK can be written. Same
-- rationale, and the same trade-off, as provenance_event.entity_id (0089): referential integrity moves to the
-- repository. Accepting that is what lets one signal store serve both entity kinds instead of two near-
-- identical tables drifting apart.
--
-- payload CARRIES NO PII, EVER — same rule as provenance_event.payload
-- A 'leadership_change' signal REFERENCES a person by id; it must never embed their email or phone. A signal
-- store that accumulates contact values becomes a second cleartext PII store with none of the channel
-- tables' encryption, blind-index dedup, or suppression wiring. This needs an itest, not a comment (Phase 9).
--
-- COMPLIANCE (09-compliance.md review gate)
-- data elements: company facts; for subject_type='person', a dated career event naming a person — PERSONAL
-- DATA even though no contact value is stored · lawful basis: per row, on the provenance event · consent
-- surface: existing · suppression: subject-level via master_persons.is_suppressed · erasure: person-subject
-- signals MUST join the DSAR fan-out (forge-core/dsar.ts + workers/queues/dsar.ts) before this table is
-- populated with person subjects. Tracked in 05-migration-plan.md; a signal left behind after an erasure is a
-- compliance failure, and a new table is exactly what quietly misses one.
--
-- ACCESS MODEL: Layer 0 — system-owned, isolated by ACCESS PATH not RLS (no workspace_id to write a
-- fail-closed predicate over). Both tables are named master_* so the convention loop in applyMigrations.ts
-- GRANTS revokes them even if the explicit list is forgotten; partitions inherit the parent ACL via
-- mirror_partition_acl (0102).
--
-- HAND-AUTHORED: master_signals is PARTITION BY RANGE, which Drizzle cannot express. master_signal_types is
-- authored here too rather than generated — the two are one unit joined by an FK, and splitting them across
-- the generated/hand-authored boundary would put half of a coupled pair in the drizzle snapshot and half
-- outside it. schema/masterSignals.ts is therefore kept out of schema/index.ts, per the provenanceEvent.ts
-- precedent.

CREATE TABLE IF NOT EXISTS master_signal_types (
  code            varchar(50) PRIMARY KEY,
  family          varchar(30) NOT NULL,
  label           varchar(120) NOT NULL,
  default_weight  integer NOT NULL DEFAULT 1,
  -- Per-type decay. NULL = does not decay (a funding round that happened stays happened).
  half_life_days  integer,
  is_enabled      boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT master_signal_types_family_enum CHECK (family IN
    ('hiring','funding','tech_change','leadership','filing','other')),
  CONSTRAINT master_signal_types_weight_range CHECK (default_weight BETWEEN 1 AND 10),
  CONSTRAINT master_signal_types_half_life_positive CHECK (
    half_life_days IS NULL OR half_life_days > 0)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS master_signals (
  id                    uuid NOT NULL DEFAULT uuid_generate_v7(),
  -- WHO/WHAT the signal is about. No FK — polymorphic; see the header.
  subject_type          varchar(10) NOT NULL,
  subject_id            uuid NOT NULL,
  type_code             varchar(50) NOT NULL REFERENCES master_signal_types(code),
  headline              varchar(500),
  -- Typed per family. NEVER PII — see the header.
  payload               jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Money, for funding/M&A signals. Minor units + ISO-4217 so no float ever touches a currency amount.
  amount_minor          bigint,
  currency              char(3),
  -- The OTHER party: acquirer, investor, or the new employer on a leadership move. SET NULL, not CASCADE —
  -- losing the counterparty must not delete the fact that the event happened.
  related_company_id    uuid REFERENCES master_companies(id) ON DELETE SET NULL,
  related_technology_id uuid REFERENCES master_technologies(id) ON DELETE SET NULL,
  confidence            numeric(4,3),
  source_name           varchar(50),
  -- Lineage into the evidence log + the human-readable citation. SET NULL for the 0089 reason: retention may
  -- reap a source_record and the signal must outlive its payload.
  evidence_ref          uuid REFERENCES source_records(id) ON DELETE SET NULL,
  evidence_url          text,
  observed_at           timestamptz NOT NULL,   -- VALID time: when the event happened. PARTITION KEY.
  recorded_at           timestamptz NOT NULL DEFAULT now(),  -- TRANSACTION time: when we learned it.
  PRIMARY KEY (id, observed_at),
  CONSTRAINT master_signals_subject_type_enum CHECK (subject_type IN ('company','person')),
  CONSTRAINT master_signals_confidence_range CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  -- An amount without a currency is unusable and a currency without an amount is noise.
  CONSTRAINT master_signals_amount_needs_currency CHECK (
    (amount_minor IS NULL AND currency IS NULL) OR (amount_minor IS NOT NULL AND currency IS NOT NULL))
) PARTITION BY RANGE (observed_at);
--> statement-breakpoint

-- Months FIRST, then the catch-all (0085/0089 ordering): a row in the DEFAULT partition blocks a later
-- CREATE ... PARTITION OF for that month outright.
SELECT ensure_month_partitions('master_signals'::regclass, 3);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS master_signals_default PARTITION OF master_signals DEFAULT;
--> statement-breakpoint

-- THE PROFILE READ: this company's / this person's signal timeline, newest first.
CREATE INDEX IF NOT EXISTS idx_master_signals_subject
  ON master_signals (subject_type, subject_id, observed_at DESC);
--> statement-breakpoint
-- THE FEED READ: everything of one type in a window ("who raised a round this month").
CREATE INDEX IF NOT EXISTS idx_master_signals_type
  ON master_signals (type_code, observed_at DESC);
--> statement-breakpoint
-- The counterparty direction: "every company this acquirer bought", "who moved TO this company".
CREATE INDEX IF NOT EXISTS idx_master_signals_related_company
  ON master_signals (related_company_id, observed_at DESC)
  WHERE related_company_id IS NOT NULL;
--> statement-breakpoint

-- REFERENCE DATA: the launch vocabulary. Reference rows, not user data — safe and correct in a migration.
-- ON CONFLICT DO NOTHING so a re-run, or a code added by hand in between, is never clobbered.
-- Half-lives are STARTING POINTS to be calibrated against real telemetry, not researched constants: a hiring
-- surge is stale in a quarter, a funding round never becomes untrue. NULL means "does not decay".
INSERT INTO master_signal_types (code, family, label, default_weight, half_life_days) VALUES
  ('job_posting_surge',    'hiring',      'Hiring surge',                    4,  90),
  ('key_role_opened',      'hiring',      'Key role opened',                 5,  120),
  ('funding_round',        'funding',     'Funding round',                   8,  NULL),
  ('acquisition',          'funding',     'Acquisition',                     9,  NULL),
  ('acquired_by',          'funding',     'Acquired by another company',     9,  NULL),
  ('ipo',                  'funding',     'IPO',                             8,  NULL),
  ('tech_adopted',         'tech_change', 'Technology adopted',              6,  180),
  ('tech_removed',         'tech_change', 'Technology removed',              7,  180),
  ('exec_hired',           'leadership',  'Executive hired',                 7,  365),
  ('exec_departed',        'leadership',  'Executive departed',              7,  365),
  ('job_change',           'leadership',  'Contact changed jobs',            8,  365),
  ('regulatory_filing',    'filing',      'Regulatory filing',               5,  NULL),
  ('office_opened',        'other',       'New office or facility',          4,  365)
ON CONFLICT (code) DO NOTHING;

-- DOWN (manual — safe while nothing reads the table):
--   DROP TABLE master_signals CASCADE;
--   DROP TABLE master_signal_types CASCADE;
