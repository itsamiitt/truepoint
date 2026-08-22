-- validationRules.sql — access model for the GLOBAL data-quality validation rules (database-management-research
-- 06). Platform-managed and app-readable, EXACTLY like retention_class_policies (rls/retention.sql): the customer
-- app role READS the rules to validate imports in-request (under withTenantTx); staff WRITE them via withPlatformTx
-- (the owner path). So a SELECT-only policy + NO write policy — under FORCE RLS the app role can never
-- INSERT/UPDATE/DELETE a rule, even though the [4/4] blanket grant re-widens it. The defensive CREATE guarantees
-- the table exists at runtime regardless of the Drizzle journal; idempotent (re-run every migrate).
--
-- VERIFIED 2026-08-22 on a fresh database (applyMigrations end-to-end): the table is created, RLS is enabled AND
-- forced, the single validation_rules_app_read(SELECT) policy is present, and leadwolf_app holds the blanket
-- SELECT/INSERT/UPDATE/DELETE grant that the missing write policy neutralises. The runtime posture above is real,
-- not aspirational.
--
-- The line this comment used to carry — "CI's drizzle-kit generate emits the canonical migration + reconciles the
-- snapshot" — is NOT safe to act on. The snapshot lineage is hand-stopped at 0028 while the journal is at 0138, so
-- a naive generate diffs against a decade-old lineage and emits ~110 migrations of DDL in one file. See
-- docs/planning/database-management-research/16-Implementation-Audit.md X2: giving this table a hand-written
-- migration like its 110 neighbours is the likelier resolution, and it is a decision, not a CI chore.
CREATE TABLE IF NOT EXISTS validation_rules (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  name varchar(120) NOT NULL,
  field varchar(60) NOT NULL,
  check_type varchar(30) NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_validation_rules_field ON validation_rules (field);

ALTER TABLE validation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE validation_rules FORCE ROW LEVEL SECURITY;

-- The app role may READ every rule (the import pipeline evaluates them in-request). No write policy exists, so
-- under FORCE RLS the app role can never INSERT/UPDATE/DELETE — rule edits are platform-only (withPlatformTx).
DROP POLICY IF EXISTS validation_rules_app_read ON validation_rules;
CREATE POLICY validation_rules_app_read ON validation_rules FOR SELECT USING (true);

-- Documentary / defense-in-depth grant (the real wall is the policy above; the [4/4] blanket grant runs after
-- this file and re-widens leadwolf_app, so this states intent rather than restricting on its own).
GRANT SELECT ON validation_rules TO leadwolf_app;
