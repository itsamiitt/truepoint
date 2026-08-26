-- validationRules.sql — access model for the GLOBAL data-quality validation rules (database-management-research
-- 06). Platform-managed and app-readable, EXACTLY like retention_class_policies (rls/retention.sql): the customer
-- app role READS the rules to validate imports in-request (under withTenantTx); staff WRITE them via withPlatformTx
-- (the owner path). So a SELECT-only policy + NO write policy — under FORCE RLS the app role can never
-- INSERT/UPDATE/DELETE a rule, even though the [4/4] blanket grant re-widens it.
--
-- The TABLE now lives in migrations/0139_validation_rules.sql. It used to be created here by a defensive
-- `CREATE TABLE IF NOT EXISTS`, because the canonical migration was expected from a CI drizzle regen that is not
-- safe to run in this tree (0083_tan_wolfpack.sql explains why). That left the table with no journal entry — the
-- one place a reader looks to find out when it appeared — so it was given a hand-written migration like its 21
-- declared neighbours, and this file kept only what an RLS file should own. Ordering holds because
-- applyMigrations runs table migrations at [2/4] and these policy files at [3/4].
--
-- VERIFIED on a fresh database (applyMigrations end-to-end): table created, RLS enabled AND forced, the single
-- validation_rules_app_read(SELECT) policy present, and leadwolf_app holding the blanket grant that the absent
-- write policy neutralises.
ALTER TABLE validation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE validation_rules FORCE ROW LEVEL SECURITY;

-- The app role may READ every rule (the import pipeline evaluates them in-request). No write policy exists, so
-- under FORCE RLS the app role can never INSERT/UPDATE/DELETE — rule edits are platform-only (withPlatformTx).
DROP POLICY IF EXISTS validation_rules_app_read ON validation_rules;
CREATE POLICY validation_rules_app_read ON validation_rules FOR SELECT USING (true);

-- Documentary / defense-in-depth grant (the real wall is the policy above; the [4/4] blanket grant runs after
-- this file and re-widens leadwolf_app, so this states intent rather than restricting on its own).
GRANT SELECT ON validation_rules TO leadwolf_app;
