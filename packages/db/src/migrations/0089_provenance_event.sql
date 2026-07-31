-- 0089_provenance_event.sql — the field-grain provenance log (docs/strategy/08-architecture.md invariant 1:
-- "Nothing writes to the materialized graph except through a provenance_event"). EXPAND ONLY: the table is
-- created empty and NOTHING reads or writes it until S-04 lands the repository and S-06 flips
-- PROVENANCE_EVENTS_ENABLED. Behaviour today is unchanged.
--
-- WHY THIS TABLE LIVES IN `public` AND NOT BEHIND A RESTRICTED SCHEMA
-- It is shaped exactly like the Layer-0 master graph: system-owned, isolated by ACCESS PATH rather than RLS.
-- Layer 0 carries no workspace_id, so no fail-closed RLS predicate can be written (rls/masterGraph.sql §4-11),
-- and this table holds Layer-0 events too. leadwolf_app is therefore REVOKE'd from it in applyMigrations.ts
-- GRANTS — "grant-off is the wall". Only `contributor_ref` needs a stronger boundary, and that goes behind its
-- own schema + role in 0090; the ref stored here is a bare uuid with no FK and nothing in `public` can resolve
-- it. The REVOKE deliberately does NOT live in rls/provenanceEvent.sql: rls/*.sql runs BEFORE the GRANTS
-- phase, so a REVOKE there would be undone by the blanket grant immediately afterwards.
--
-- WHY THERE IS NO UNIQUE IDEMPOTENCY INDEX (read before adding one)
-- A partitioned table's unique indexes MUST include the partition key. A UNIQUE on
-- (source_record_id, entity_type, entity_id, field, action) would silently become
-- (…, recorded_at) — i.e. "one event per replay timestamp" instead of "one event per assertion", which is the
-- exact trap 0085 documents for provider_calls and email_event. An index whose name promises idempotency it
-- cannot deliver is worse than no index, so the lookup index below is deliberately NON-unique.
--
-- Idempotency is therefore an UPSTREAM contract, and S-04 must honour it: source_records.content_hash is
-- UNIQUE and NOT partitioned, so an identical payload never produces a second source_record. The event append
-- MUST be skipped when appendSourceRecord was a no-op (a conflict, not an insert) — appending events off an
-- already-seen payload is what would duplicate them. That contract needs a test, not a comment.
--
-- Partitioned monthly on recorded_at from day one, while the table is empty. The partition sweep is
-- CATALOG-driven (partitionRepository.listPartitionedTables asks pg_class for relkind='p' in public), so this
-- table is maintained automatically with no registry to update. This is also the cheapest rollback lever:
-- undoing a bad backfill is DETACH + DROP of a month, not a multi-hour DELETE against a live table.

CREATE TABLE IF NOT EXISTS provenance_event (
  id                uuid NOT NULL DEFAULT uuid_generate_v7(),
  -- WHAT is asserted, at FIELD grain.
  entity_type       varchar(20) NOT NULL,
  entity_id         uuid NOT NULL,          -- master_*.id for Layer 0; contacts.id/accounts.id for the overlay.
                                            -- No FK by design: cross-layer, and re-pointable on an ER merge.
  field             varchar(50) NOT NULL,   -- 'jobTitle' | 'primary_domain' | '*' for whole-entity actions
  action            varchar(20) NOT NULL,
  -- WHERE it came from — the five-tuple invariant 1 requires.
  source_type       varchar(30) NOT NULL,
  source_name       varchar(50),            -- 'zoominfo' | 'apollo' | NULL. NEVER a workspace id (C-02).
  method            varchar(30),
  contributor_ref   uuid,                   -- OPAQUE. No FK. Resolvable ONLY inside the provenance schema (0090).
  lawful_basis      varchar(30) NOT NULL,   -- 09-compliance rule 4: untaggable data does not enter the graph.
  -- THE ASSERTION.
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence        numeric(4,3),
  acceptance_state  varchar(20) NOT NULL DEFAULT 'accepted',
  -- LINEAGE back into the shipped evidence log. SET NULL, not CASCADE: retention may reap a source_record at
  -- 730d and the assertion must outlive its payload.
  source_record_id  uuid REFERENCES source_records(id) ON DELETE SET NULL,
  scope_ref         uuid,                   -- workspace_id for overlay events; NULL for Layer 0
  -- VALID time vs TRANSACTION time. observed_at is when the source says the fact held; recorded_at is when we
  -- learned it. Confidence decay (Phase 2) reads observed_at; the projection watermark reads recorded_at.
  observed_at       timestamptz,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, recorded_at),
  CONSTRAINT provenance_event_entity_type_enum CHECK (entity_type IN
    ('person','company','employment','email','phone','contact','account')),
  CONSTRAINT provenance_event_action_enum CHECK (action IN
    ('assert','confirm','deny','correct','verify','pin','tombstone','merge')),
  CONSTRAINT provenance_event_source_type_enum CHECK (source_type IN
    ('provider','import','coop','forge','crawl','user_edit','reveal','extension','crm_sync','mailbox')),
  -- Mirrors the consent_records vocabulary exactly — one lawful-basis vocabulary across the product.
  CONSTRAINT provenance_event_lawful_basis_enum CHECK (lawful_basis IN
    ('legitimate_interest','consent','contract','public_record')),
  CONSTRAINT provenance_event_acceptance_enum CHECK (acceptance_state IN
    ('accepted','pending','rejected','superseded')),
  CONSTRAINT provenance_event_confidence_range CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  -- An overlay event is workspace-scoped by definition; a Layer-0 event has no workspace. Enforcing the
  -- correspondence here stops a Layer-0 event from silently carrying a tenant hint (C-02).
  CONSTRAINT provenance_event_scope_matches_layer CHECK (
    (entity_type IN ('contact','account') AND scope_ref IS NOT NULL)
    OR (entity_type NOT IN ('contact','account') AND scope_ref IS NULL)
  )
) PARTITION BY RANGE (recorded_at);
--> statement-breakpoint

-- Months FIRST, then the catch-all (the 0085 ordering rationale): rows must land in a real month where one
-- exists, because anything sitting in the DEFAULT partition blocks a later CREATE ... PARTITION OF for that
-- month outright. The default is belt-and-braces — if the sweep ever stops, writes land there instead of
-- failing on the 1st.
SELECT ensure_month_partitions('provenance_event'::regclass, 3);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS provenance_event_default PARTITION OF provenance_event DEFAULT;
--> statement-breakpoint

-- THE FOLD: rebuild one entity's field_provenance from its events, newest first. Created on the parent so it
-- propagates to every partition, existing and future.
CREATE INDEX IF NOT EXISTS idx_prov_event_entity
  ON provenance_event (entity_type, entity_id, field, recorded_at DESC);
--> statement-breakpoint
-- THE BADGE (S-10/S-13): count(DISTINCT contributor_ref) + max(observed_at) per entity. The ref is aggregated
-- inside the database and never leaves it as a value.
CREATE INDEX IF NOT EXISTS idx_prov_event_badge
  ON provenance_event (entity_type, entity_id, observed_at DESC);
--> statement-breakpoint
-- REPLAY / DEDUP LOOKUP — non-unique, for the reason set out in the header. Partial: the majority of events
-- carry a source_record, and the ones that do not (user_edit, confirm/deny) are never looked up this way.
CREATE INDEX IF NOT EXISTS idx_prov_event_source_record
  ON provenance_event (source_record_id, entity_type, entity_id, field)
  WHERE source_record_id IS NOT NULL;

-- DOWN (manual — safe at any point while PROVENANCE_EVENTS_ENABLED is off, since nothing reads the table):
--   DROP TABLE provenance_event CASCADE;
