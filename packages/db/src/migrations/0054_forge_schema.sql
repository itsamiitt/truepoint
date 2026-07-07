-- 0054_forge_schema — the TruePoint Forge data plane in its own `forge` Postgres schema (ADR-0047; nested from
-- the standalone truepoint-forge repo). HAND-AUTHORED (drizzle-kit generate is forbidden). Owned by the
-- least-privilege leadwolf_forge role (see applyMigrations) — isolated from the tenant overlay. Consolidates
-- the source repo's migrations 0000-0006.
CREATE SCHEMA IF NOT EXISTS forge;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forge.raw_captures (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source              text NOT NULL,
  endpoint            text NOT NULL,
  schema_version      text NOT NULL,
  content_hash        text NOT NULL,
  content_type        text NOT NULL DEFAULT 'application/json',
  captured_by_user_id uuid,
  target_tenant_id    uuid NOT NULL,
  target_workspace_id uuid,
  consent_snapshot    jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_inline      text,
  payload_ref         text,
  byte_size           bigint NOT NULL,
  is_gzipped          boolean NOT NULL DEFAULT false,
  status              text NOT NULL DEFAULT 'landed',
  ingested_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT raw_captures_one_payload CHECK ((payload_inline IS NOT NULL) <> (payload_ref IS NOT NULL)),
  CONSTRAINT raw_captures_status CHECK (status IN ('landed','parsed','erased'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_raw_captures_content_hash ON forge.raw_captures (content_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_raw_captures_ingested_at ON forge.raw_captures (ingested_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forge.capture_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source           text NOT NULL,
  idempotency_key  text NOT NULL,
  byte_size        bigint NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'received',
  accepted_count   integer NOT NULL DEFAULT 0,
  duplicate_count  integer NOT NULL DEFAULT 0,
  rejected_count   integer NOT NULL DEFAULT 0,
  reject_histogram jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_capture_batches_idempotency_key ON forge.capture_batches (idempotency_key);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forge.parsers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source     text NOT NULL,
  endpoint   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_parsers_source_endpoint ON forge.parsers (source, endpoint);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forge.parser_versions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parser_id             uuid NOT NULL REFERENCES forge.parsers (id) ON DELETE CASCADE,
  version               text NOT NULL,
  status                text NOT NULL DEFAULT 'draft',
  output_schema         jsonb NOT NULL DEFAULT '{}'::jsonb,
  compatibility         text,
  golden_fixture_ref    text,
  supersedes_version_id uuid,
  published_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT parser_versions_status CHECK (status IN ('draft','active','deprecated','retired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_parser_versions_one_active ON forge.parser_versions (parser_id) WHERE status = 'active';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forge.parsed_records (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_capture_id    uuid NOT NULL REFERENCES forge.raw_captures (id) ON DELETE CASCADE,
  parser_version_id uuid NOT NULL REFERENCES forge.parser_versions (id),
  entity_kind       text NOT NULL DEFAULT 'person',
  fields            jsonb NOT NULL DEFAULT '[]'::jsonb,
  field_provenance  jsonb NOT NULL DEFAULT '[]'::jsonb,
  parse_status      text NOT NULL,
  parse_errors      jsonb NOT NULL DEFAULT '[]'::jsonb,
  block_key         text,
  email_blind_index text,
  phone_blind_index text,
  superseded        boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT parsed_records_status CHECK (parse_status IN ('parsed','partial','failed','quarantined'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_parsed_records_capture_version ON forge.parsed_records (raw_capture_id, parser_version_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forge.extraction_runs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                 text NOT NULL,
  target_tenant_id       uuid,
  task                   text NOT NULL DEFAULT 'extract',
  model                  text NOT NULL,
  outcome                text NOT NULL,
  used_repair            boolean NOT NULL DEFAULT false,
  extract_schema_version text,
  grounding_coverage     numeric(4,3),
  judge_score            numeric(4,3),
  confidence             numeric(4,3),
  latency_ms             integer,
  input_tokens           integer,
  output_tokens          integer,
  cached_tokens          integer,
  created_at             timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_extraction_runs_drift ON forge.extraction_runs (extract_schema_version, model);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forge.verified_records (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_hash        text NOT NULL,
  entity_kind         text NOT NULL,
  fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence          numeric(4,3),
  review_status       text NOT NULL DEFAULT 'verified',
  email_blind_index   text,
  email_enc           bytea,
  phone_blind_index   text,
  phone_enc           bytea,
  is_suppressed       boolean NOT NULL DEFAULT false,
  version             integer NOT NULL DEFAULT 1,
  approved_by_user_id uuid,
  approval_request_id uuid,
  verified_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_verified_records_content_hash ON forge.verified_records (content_hash);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forge.verified_record_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  verified_id       uuid NOT NULL REFERENCES forge.verified_records (id) ON DELETE CASCADE,
  event_type        text NOT NULL,
  version           integer NOT NULL DEFAULT 1,
  winning_source    text,
  source_record_ref text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forge.sync_state (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_kind  text NOT NULL,
  verified_id  uuid NOT NULL,
  status       text NOT NULL DEFAULT 'pending',
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sync_state_entity ON forge.sync_state (entity_kind, verified_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forge.sync_outbox (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type     text NOT NULL,
  aggregate_kind text NOT NULL DEFAULT 'verified_person',
  forge_id       uuid,
  version        integer NOT NULL DEFAULT 1,
  content_hash   text NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         text NOT NULL DEFAULT 'pending',
  available_at   timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  dispatched_at  timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending ON forge.sync_outbox (status, available_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forge.master_id_map (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  forge_id       uuid NOT NULL,
  master_id      uuid,
  entity_kind    text NOT NULL,
  content_hash   text NOT NULL,
  synced_version integer NOT NULL DEFAULT 0,
  reconciled_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_master_id_map_forge ON forge.master_id_map (forge_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forge.approval_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  op_class             text NOT NULL,
  requested_by_user_id uuid NOT NULL,
  decided_by_user_id   uuid,
  status               text NOT NULL DEFAULT 'pending',
  payload              jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  executed_at          timestamptz,
  CONSTRAINT approval_requests_four_eyes CHECK (decided_by_user_id IS NULL OR decided_by_user_id <> requested_by_user_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forge.review_tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_type        text NOT NULL,
  subject_ref      text NOT NULL,
  confidence       numeric(4,3),
  priority         integer NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'open',
  assignee_user_id uuid,
  claimed_at       timestamptz,
  sla_due_at       timestamptz,
  is_honeypot      boolean NOT NULL DEFAULT false,
  resolution       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_review_tasks_rank ON forge.review_tasks (status, priority);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_review_tasks_sla ON forge.review_tasks (sla_due_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forge.forge_audit_log (
  seq        bigserial PRIMARY KEY,
  action     text NOT NULL,
  actor_kind text NOT NULL,
  actor_id   text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash  text NOT NULL,
  row_hash   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_forge_audit_row_hash ON forge.forge_audit_log (row_hash);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forge.match_candidates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  left_ref     uuid NOT NULL,
  right_ref    uuid NOT NULL,
  block_key    text NOT NULL,
  match_weight numeric(8,4),
  disposition  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_match_candidates_block ON forge.match_candidates (block_key);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forge.match_links (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type       text NOT NULL,
  cluster_id        uuid NOT NULL,
  source_ref        uuid NOT NULL,
  match_probability numeric(4,3),
  match_weight      numeric(8,4),
  match_method      text NOT NULL DEFAULT 'fellegi_sunter',
  is_duplicate_of   uuid,
  review_status     text NOT NULL DEFAULT 'auto',
  resolved_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT match_links_review_status CHECK (review_status IN ('auto','pending','confirmed','rejected'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_match_links_cluster ON forge.match_links (entity_type, cluster_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forge.merge_log (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id         uuid NOT NULL,
  decision           text NOT NULL,
  survivorship       jsonb NOT NULL DEFAULT '{}'::jsonb,
  match_weight       numeric(8,4),
  decided_by_user_id uuid,
  reason             text,
  reverses_merge_id  uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);
