-- 0139_validation_rules.sql — the canonical migration for `validation_rules` (database-management-research 06;
-- audit X2). HAND-AUTHORED (drizzle-kit generate is forbidden — see 0083_tan_wolfpack.sql for why a regen in
-- this tree emits destructive nonsense for RLS/partition/expression DDL it cannot model).
--
-- WHY THIS EXISTS AT 0139 RATHER THAN WITH THE FEATURE. The table shipped without a migration: it was created
-- by a defensive `CREATE TABLE IF NOT EXISTS` inside rls/validationRules.sql, on the reasoning that CI's
-- drizzle regen would emit the canonical one later. That regen is not safe to run here, so "later" never came
-- and the table had no entry in the journal — the one place a reader looks to find out when a table appeared.
-- This file is that entry, and rls/validationRules.sql now owns only what an RLS file should: the policy and
-- the grant.
--
-- SAFE ON EVERY EXISTING DATABASE. `IF NOT EXISTS` throughout, and the shape below is byte-identical to the
-- defensive CREATE it replaces, so on any database migrated before today this is a no-op — the table, the
-- primary key and the index are already there. On a fresh database the ordering works because applyMigrations
-- runs table migrations at [2/4] and RLS files at [3/4]: this creates the table, then the RLS file enables and
-- forces row security and installs the read policy.
--
-- The access model itself is unchanged and lives next door: platform-managed, app-readable, exactly like
-- retention_class_policies. Staff write rules through withPlatformTx; under FORCE RLS with no write policy the
-- app role can only ever SELECT.

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
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_validation_rules_field ON validation_rules (field);
