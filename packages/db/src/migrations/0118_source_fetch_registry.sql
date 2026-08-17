-- 0118_source_fetch_registry.sql — the Layer-0 URL fetch registry [S-09][S-13][A-01]
-- (hand-authored, additive-only; docs/planning ecosystem work).
--
-- One row per canonical LinkedIn/Sales-Nav URL, with a real last_fetched_at written on the fetch ATTEMPT —
-- the 30-day freshness clock nothing existing could provide (source_records skips byte-identical refetches;
-- provider_calls is workspace-scoped and never advances called_at on a hit). Platform-global, system-owned;
-- leadwolf_app is REVOKEd entirely in applyMigrations (NOT master_*-prefixed, so the convention loop does
-- not cover it — the explicit REVOKE is load-bearing). Holds URLs + ids only, never PII.

CREATE TABLE IF NOT EXISTS "source_fetch_registry" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "entity_kind" varchar(10) NOT NULL,
  "normalized_url" varchar(500) NOT NULL,
  "external_id" varchar(64),
  "source_name" varchar(50) NOT NULL DEFAULT 'linkedin_api',
  "first_seen_at" timestamptz NOT NULL DEFAULT now(),
  "last_fetched_at" timestamptz,
  "last_outcome" varchar(20),
  "fetch_count" integer NOT NULL DEFAULT 0,
  "resolved_person_id" uuid,
  "resolved_company_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "source_fetch_registry_entity_kind_enum" CHECK ("entity_kind" IN ('person','company'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_source_fetch_registry_target"
  ON "source_fetch_registry" ("entity_kind", "normalized_url");
--> statement-breakpoint
-- The sweep predicate: per-kind, never-fetched first (NULLS FIRST), then stalest. Hand-authored because the
-- NULLS FIRST ordering is not expressible from the schema file.
CREATE INDEX IF NOT EXISTS "idx_source_fetch_registry_due"
  ON "source_fetch_registry" ("entity_kind", "last_fetched_at" NULLS FIRST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_source_fetch_registry_external"
  ON "source_fetch_registry" ("external_id")
  WHERE "external_id" IS NOT NULL;
