-- 0134_database_company_search.sql — index the GLOBAL company search over Layer-0 (search-consolidation
-- stage 2; docs/planning/search-consolidation/03-migration-and-index-plan.md). [S-04][S-09][S-10]
--
-- HAND-AUTHORED, the 0123/0132/0133 pattern verbatim: every CREATE INDEX is CONCURRENTLY (no ACCESS
-- EXCLUSIVE lock on the shared graph), so each is the ONLY statement in its batch — one per breakpoint
-- marker, and that marker string is never quoted anywhere in this file, because applyMigrations splits on it
-- literally and a comment containing it would be cut in half. IF NOT EXISTS makes the file re-runnable; the
-- sweep below drops an INVALID leftover first, since a failed CONCURRENTLY build leaves one that
-- IF NOT EXISTS would skip past forever. CONCURRENTLY is safe in this migrator: applyMigrations runs each
-- statement separately in AUTOCOMMIT (0106/0109 document this).
--
-- EXPAND ONLY. No column is dropped, renamed or retyped; no data is touched.
--
-- Every index is PARTIAL on MASTER_COMPANY_VISIBLE — the predicate in
-- packages/db/src/repositories/masterCompanyReadRepository.ts:
--
--     org_kind = 'company' AND primary_domain IS NOT NULL AND field_provenance <> '{}'::jsonb
--
-- Keep the two byte-identical. A partial index is only used when the planner can prove the query's predicate
-- implies the index's, so a drifting clause does not degrade gracefully — it silently stops being used.
--
-- WHY THE PROVENANCE CLAUSE. It is what separates a real company from a minted stub, and it is not the
-- obvious choice. A company first observed as a numeric LinkedIn id on someone's position is minted with
-- only a name, and fillCompanyPrimaryDomain later back-fills a domain onto it from the employer's website —
-- so `primary_domain IS NOT NULL` does NOT filter stubs out. Measured against production on 2026-08-21:
-- 3,747 rows pass org_kind + domain and only 231 of them carry any firmographics. updateCompanyProfile
-- stamps field_provenance if and only if a company document actually landed. At that shape every index
-- below covers ~231 of 4,427 rows, so they are small.
--
-- Kill date: the same as 0123's — when a search-engine adapter takes over the database scope, drop these.

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND NOT i.indisvalid
       AND c.relname IN ('idx_master_companies_visible_keyset',
                         'idx_master_companies_visible_domain',
                         'idx_master_companies_visible_name_asc',
                         'idx_master_companies_visible_headcount',
                         'idx_master_companies_visible_updated',
                         'idx_master_companies_visible_hq_country',
                         'idx_master_companies_visible_ownership',
                         'idx_master_companies_visible_founded',
                         'idx_master_companies_visible_employees',
                         'idx_master_companies_visible_revenue',
                         'idx_master_companies_trgm_domain',
                         'idx_master_companies_trgm_hq_city',
                         'idx_master_companies_gin_specialties',
                         'idx_master_company_locations_hq_region')
  LOOP
    EXECUTE format('DROP INDEX CONCURRENTLY IF EXISTS public.%I', r.relname);
  END LOOP;
END $$;
--> statement-breakpoint

-- Long index builds must not be killed by the migration timeout.
SET statement_timeout = 0;
--> statement-breakpoint

-- ── Keyset / cursor orders. One index per sort in masterCompanySearchRepository.SORTS ────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_companies_visible_keyset
  ON master_companies (created_at DESC, primary_domain DESC)
  WHERE org_kind = 'company' AND primary_domain IS NOT NULL AND field_provenance <> '{}'::jsonb;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_companies_visible_updated
  ON master_companies (updated_at DESC, primary_domain DESC)
  WHERE org_kind = 'company' AND primary_domain IS NOT NULL AND field_provenance <> '{}'::jsonb;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_companies_visible_name_asc
  ON master_companies (name ASC, primary_domain ASC)
  WHERE org_kind = 'company' AND primary_domain IS NOT NULL AND field_provenance <> '{}'::jsonb;
--> statement-breakpoint
-- EXPRESSION index: the repository orders and seeks on coalesce(employee_count, -1) so unknown headcount
-- sorts last deterministically. A plain column index does NOT match a coalesce() expression — this is the
-- one that serves it, and the expression must stay byte-in-step with the repository (the
-- idx_contacts_ws_priority_score_coalesced precedent).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_companies_visible_headcount
  ON master_companies ((coalesce(employee_count, -1)) DESC, primary_domain DESC)
  WHERE org_kind = 'company' AND primary_domain IS NOT NULL AND field_provenance <> '{}'::jsonb;
--> statement-breakpoint
-- Point lookup by the addressing key (the profile route + the count path).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_companies_visible_domain
  ON master_companies (primary_domain)
  WHERE org_kind = 'company' AND primary_domain IS NOT NULL AND field_provenance <> '{}'::jsonb;
--> statement-breakpoint

-- ── Term + range filters ─────────────────────────────────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_companies_visible_hq_country
  ON master_companies (hq_country)
  WHERE org_kind = 'company' AND primary_domain IS NOT NULL AND field_provenance <> '{}'::jsonb;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_companies_visible_ownership
  ON master_companies (ownership_type)
  WHERE org_kind = 'company' AND primary_domain IS NOT NULL AND field_provenance <> '{}'::jsonb;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_companies_visible_founded
  ON master_companies (year_founded)
  WHERE org_kind = 'company' AND primary_domain IS NOT NULL AND field_provenance <> '{}'::jsonb;
--> statement-breakpoint
-- Serves BOTH the employee_count range clause and the derived employee_band term (which the repository
-- translates into employee_count ranges, because master_companies.employee_band has no writer).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_companies_visible_employees
  ON master_companies (employee_count)
  WHERE org_kind = 'company' AND primary_domain IS NOT NULL AND field_provenance <> '{}'::jsonb;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_companies_visible_revenue
  ON master_companies (revenue_min_minor, revenue_max_minor)
  WHERE org_kind = 'company' AND primary_domain IS NOT NULL AND field_provenance <> '{}'::jsonb;
--> statement-breakpoint

-- ── Text legs ────────────────────────────────────────────────────────────────────────────────────────────
-- primary_domain is CITEXT, and gin_trgm_ops is defined over `text` — citext is not binary-coercible to it,
-- so `gin (primary_domain gin_trgm_ops)` does not merely go unused, it FAILS to create ("no default operator
-- class") and would break every migrate run. It must be the ::text EXPRESSION, and the repository's free-text
-- leg casts identically so the expression matches. 0081 records the same trap for contacts.email_domain and
-- accounts.domain. (master_companies.name already has its trgm GIN from 0123 — do not re-create it.)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_companies_trgm_domain
  ON master_companies USING gin ((primary_domain::text) gin_trgm_ops)
  WHERE org_kind = 'company' AND primary_domain IS NOT NULL AND field_provenance <> '{}'::jsonb;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_companies_trgm_hq_city
  ON master_companies USING gin (hq_city gin_trgm_ops)
  WHERE org_kind = 'company' AND primary_domain IS NOT NULL AND field_provenance <> '{}'::jsonb;
--> statement-breakpoint
-- specialties is text[]; the repository uses array OVERLAP (&&), which is what a GIN on the array serves.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_companies_gin_specialties
  ON master_companies USING gin (specialties)
  WHERE org_kind = 'company' AND primary_domain IS NOT NULL AND field_provenance <> '{}'::jsonb;
--> statement-breakpoint

-- ── HQ region (the country → state → city cascade lives on the locations edge, not the company row) ───────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_master_company_locations_hq_region
  ON master_company_locations (master_company_id, region)
  WHERE kind = 'hq';
--> statement-breakpoint

SET statement_timeout = '120s';

-- DOWN (manual; forward-only project): DROP INDEX CONCURRENTLY IF EXISTS for each index above. Safe for
-- correctness, costly for performance — every filter reverts to a scan of the visible company population.
