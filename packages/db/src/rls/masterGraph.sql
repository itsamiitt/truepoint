-- masterGraph.sql — updated_at triggers ONLY for the Layer-0 master graph (ADR-0021): master_persons,
-- master_companies, master_employment, master_emails, master_phones, source_records, match_links.
--
-- DELIBERATELY NO RLS HERE. Layer 0 is the SYSTEM-OWNED shared universe; it carries NO workspace_id, so there
-- is no tenant predicate to enforce and a fail-closed RLS policy is impossible to write. Isolation is by
-- ACCESS PATH, not row policy: the customer app role (leadwolf_app) is denied DML on these tables outright by
-- the grant-off in applyMigrations.ts GRANTS ("grant-off is the wall", PLAN_04 §RLS-2 / PLAN_07 §0.1/§RLS-1).
-- Therefore this file does NOT ENABLE/FORCE ROW LEVEL SECURITY, creates NO policy, and GRANTs nothing to
-- leadwolf_app. It also does NOT REVOKE: the GRANTS phase (and its REVOKE) runs AFTER all rls/*.sql files, so
-- the REVOKE lives there — putting one here would run before the blanket GRANT and be undone immediately.
-- Idempotent: safe to re-run on every migrate.
--
-- set_updated_at() is the shared trigger function defined in contacts.sql, which sorts before masterGraph.sql
-- (c < m) and so has already run when this file executes. Only the three master tables that carry updated_at
-- get the trigger; master_emails / master_phones / source_records / match_links have no updated_at column.

-- ── master_persons ─────────────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS master_persons_set_updated_at ON master_persons;
CREATE TRIGGER master_persons_set_updated_at BEFORE UPDATE ON master_persons
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── master_companies ───────────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS master_companies_set_updated_at ON master_companies;
CREATE TRIGGER master_companies_set_updated_at BEFORE UPDATE ON master_companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── master_employment ──────────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS master_employment_set_updated_at ON master_employment;
CREATE TRIGGER master_employment_set_updated_at BEFORE UPDATE ON master_employment
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
