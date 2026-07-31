-- provenanceEvent.sql — append-only trigger for `provenance_event` (docs/strategy/08-architecture.md
-- invariant 1). The immutable field-grain assertion log behind the confidence model and A-01.
--
-- DELIBERATELY NO RLS HERE, for exactly the reason masterGraph.sql gives: this table holds Layer-0 events,
-- Layer 0 carries no workspace_id, and a fail-closed RLS predicate cannot be written over a column that does
-- not exist. Isolation is by ACCESS PATH — leadwolf_app is denied DML outright in applyMigrations.ts GRANTS
-- ("grant-off is the wall"). Overlay events do carry scope_ref, but they live in the same table as Layer-0
-- events and are read by the same system paths, so splitting the enforcement model per row-kind would buy
-- nothing and add a second thing to get wrong.
--
-- This file also does NOT REVOKE. The GRANTS phase runs AFTER every rls/*.sql, so a REVOKE placed here would
-- be undone by the blanket grant moments later — the same trap masterGraph.sql documents.
--
-- APPEND-ONLY, enforced for EVERY role including the owner (mirrors audit_log and credit_ledger). A
-- correction is a NEW event with action='correct'; a retraction is action='tombstone'. Nothing is ever edited,
-- because an audit log that can be rewritten is not evidence — and A-01/A-03 both rest on this table being
-- evidence.
--
-- ONE sanctioned mutation, matching the credit_ledger precedent: source_record_id's own ON DELETE SET NULL,
-- fired when retention reaps a source_record at 730d. The assertion must outlive its payload, so the pointer
-- nulls out and every other column stays byte-identical. Any other UPDATE, and every DELETE, raises.
--
-- Idempotent (CREATE OR REPLACE + DROP … IF EXISTS): safe to re-run on every migrate.

CREATE OR REPLACE FUNCTION provenance_event_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.source_record_id IS NULL AND OLD.source_record_id IS NOT NULL
     AND (to_jsonb(NEW) - 'source_record_id') = (to_jsonb(OLD) - 'source_record_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'provenance_event is append-only (08-architecture invariant 1)';
END;
$$ LANGUAGE plpgsql;

-- On the PARENT: a row-level trigger on a partitioned table propagates to every partition, existing and
-- future, so a partition created by next month's sweep is covered without a second change to remember.
DROP TRIGGER IF EXISTS provenance_event_no_mutation ON provenance_event;
CREATE TRIGGER provenance_event_no_mutation BEFORE UPDATE OR DELETE ON provenance_event
  FOR EACH ROW EXECUTE FUNCTION provenance_event_append_only();
