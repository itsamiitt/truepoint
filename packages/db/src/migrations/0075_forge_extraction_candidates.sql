-- 0075_forge_extraction_candidates.sql — the AI-extract stage (S2) output store (P-01.2). runExtraction produced
-- per-field candidates {path, value, confidence, band, grounded} but the worker DISCARDED the return value, so the
-- pipeline paid for extraction and persisted NOTHING for promotion to promote. One row per (raw_capture_id, path),
-- idempotent so a re-extraction converges. Same PII posture as parsed_records.fields (non-channel profile fields
-- stored as jsonb; channel PII stays blind-index-only) — encryption-at-rest for both is the F2 security task.
-- HAND-AUTHORED (drizzle-kit generate is forbidden). leadwolf_forge is granted via the ALL-TABLES grant that runs
-- after migrations in applyMigrations.
CREATE TABLE IF NOT EXISTS forge.extraction_candidates (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_capture_id         uuid NOT NULL REFERENCES forge.raw_captures (id) ON DELETE CASCADE,
  path                   text NOT NULL,
  value                  jsonb,
  confidence             numeric(4,3) NOT NULL,
  band                   text NOT NULL,
  grounded               boolean NOT NULL,
  extract_schema_version text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extraction_candidates_band CHECK (band IN ('auto','review','quarantine'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_extraction_candidates_capture_path ON forge.extraction_candidates (raw_capture_id, path);

-- DOWN (manual — safe while Forge is dark / nothing extracted):
--   DROP TABLE IF EXISTS forge.extraction_candidates;
