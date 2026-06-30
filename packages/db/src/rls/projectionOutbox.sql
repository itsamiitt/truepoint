-- projectionOutbox.sql — defensive-CREATE for projection_outbox (prospect-database-platform I1 / Phase 05; audit
-- P03). The survivorship projector drains this queue to rebuild a golden cluster from the source_records/match_links
-- evidence log. SYSTEM-OWNED Layer-0: NO tenant scope and NO RLS policy — isolation is by access path (the
-- leadwolf_app role is REVOKE-d, leadwolf_er GRANT-ed, both in applyMigrations' grants phase, which runs AFTER this
-- file). The defensive CREATE guarantees the table exists at runtime regardless of the Drizzle journal (CI emits
-- the canonical migration + reconciles the snapshot); idempotent (re-run every migrate).
CREATE TABLE IF NOT EXISTS projection_outbox (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  entity_type varchar(10) NOT NULL,
  cluster_id uuid NOT NULL,
  reason varchar(30) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'pending',
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_projection_outbox_status ON projection_outbox (status, enqueued_at);
