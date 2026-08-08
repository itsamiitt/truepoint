-- masterTechnology.sql — updated_at trigger ONLY for the Layer-0 technology/product catalog:
-- master_technologies (the sole table here carrying updated_at).
--
-- DELIBERATELY NO RLS HERE, for exactly the reason masterGraph.sql states: Layer 0 is the SYSTEM-OWNED shared
-- universe. These tables carry NO workspace_id, so there is no tenant predicate to enforce and a fail-closed
-- RLS policy is impossible to write. Isolation is by ACCESS PATH: leadwolf_app is denied DML outright by the
-- grant-off in applyMigrations.ts GRANTS ("grant-off is the wall"). Therefore this file does NOT ENABLE/FORCE
-- ROW LEVEL SECURITY, creates NO policy, and GRANTs nothing to leadwolf_app.
--
-- It also does NOT REVOKE. The GRANTS phase (and its REVOKE) runs AFTER all rls/*.sql files, so a REVOKE here
-- would execute BEFORE the blanket GRANT and be undone immediately. Same trap masterGraph.sql documents.
--
-- Two things make these tables fail closed even if a future phase forgets the explicit REVOKE list:
--   1. every table is named master_*, which the convention-based catch-all loop in GRANTS revokes; and
--   2. they are named in the explicit REVOKE list anyway (belt and braces).
--
-- set_updated_at() is the shared trigger function defined in contacts.sql, which sorts before
-- masterTechnology.sql (c < m) and so has already run when this file executes. Only master_technologies
-- carries updated_at; the category/alias/vendor/feature tables are append-mostly and have created_at only.
-- Idempotent: safe to re-run on every migrate.

-- ── master_technologies ────────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS master_technologies_set_updated_at ON master_technologies;
CREATE TRIGGER master_technologies_set_updated_at BEFORE UPDATE ON master_technologies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
