-- 0077_forge_quarantine.sql — persist the parse quarantine lane (P-01.8). Selection/shape/parse drift was routed
-- to a console.warn and LOST — a drifted or unparseable capture left no auditable record, no signal to alert on,
-- and no way to replay. One row per (raw_capture_id, route), idempotent (a re-quarantine refreshes the reason).
-- HAND-AUTHORED (drizzle-kit generate is forbidden); leadwolf_forge is granted via the post-migration ALL-TABLES
-- grant in applyMigrations.
CREATE TABLE IF NOT EXISTS forge.quarantine (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_capture_id uuid NOT NULL REFERENCES forge.raw_captures (id) ON DELETE CASCADE,
  route          text NOT NULL,
  reason         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_quarantine_capture_route ON forge.quarantine (raw_capture_id, route);

-- DOWN (manual — safe while Forge is dark):
--   DROP TABLE IF EXISTS forge.quarantine;
