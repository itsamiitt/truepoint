-- 0053_processed_sync_events — the idempotent-consumer dedup table for the Forge master-sync apply
-- (docs/planning/forge/11 §3, G-FORGE-1108). HAND-AUTHORED (drizzle-kit generate is unsafe here). Written under
-- leadwolf_er (see applyMigrations GRANT); system-owned, no RLS.
CREATE TABLE IF NOT EXISTS "processed_sync_events" (
  "event_id"     uuid PRIMARY KEY,
  "content_hash" bytea,
  "applied_at"   timestamptz NOT NULL DEFAULT now()
);
