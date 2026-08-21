# 03 — Migration and Index Plan

Two migrations. Both **expand-only**: no column is dropped, renamed, or retyped, and
no data is destroyed. Forward-only project, so each carries a manual DOWN note.

House posture, followed exactly (`0081` → `0123` → `0132` → `0133`):

- **Hand-authored.** `drizzle-kit generate` emits only plain, blocking `CREATE INDEX`;
  every index here is partial, expression, or GIN and must be `CONCURRENTLY` on hot
  tables.
- **`CONCURRENTLY` everywhere**, which is safe in this migrator because
  `applyMigrations.ts` runs each statement separately in AUTOCOMMIT. Each is the only
  statement in its batch (one per `--> statement-breakpoint`; the marker string is
  never quoted inside the file, or the splitter would cut a comment in half).
- **`SET statement_timeout = 0`** around the builds; restored at the end.
- **Invalid-leftover sweep** at the top (the `0132`/`0133` `DO $$` block): a failed
  `CONCURRENTLY` build leaves an INVALID index that `IF NOT EXISTS` would skip past
  forever. Drop by name, then rebuild.
- **Verified missing** against every `CREATE INDEX` in `0000`–`0133` *and* the Drizzle
  schema defs before being added — a redundant index is write amplification forever.

## `0134_database_company_search.sql` — the Accounts tab's index set

Every index is **PARTIAL on `MASTER_COMPANY_VISIBLE`** — `org_kind = 'company' AND
primary_domain IS NOT NULL AND field_provenance <> '{}'::jsonb` — matching the `0123`
posture for people: the index covers only the population the search may return, so the
minted-stub and school rows cost nothing.

At today's production shape that is **231 of 4,427 rows**, so every index below is
tiny. Keep the predicate byte-identical between `masterCompanyReadRepository`'s
exported fragment and these `WHERE` clauses — a partial index is only used when the
planner can prove the query's predicate implies the index's.

```
-- keyset / count path (the cursor order)
idx_master_companies_visible_keyset      (created_at DESC, primary_domain DESC)  PARTIAL
idx_master_companies_visible_domain      (primary_domain)                        PARTIAL
idx_master_companies_visible_name_asc    (name ASC, primary_domain ASC)          PARTIAL
idx_master_companies_visible_headcount   ((coalesce(employee_count,-1)) DESC, primary_domain DESC) PARTIAL

-- term / range filters
idx_master_companies_visible_hq_country  (hq_country)         PARTIAL
idx_master_companies_visible_ownership   (ownership_type)     PARTIAL
idx_master_companies_visible_founded     (year_founded)       PARTIAL
idx_master_companies_visible_employees   (employee_count)     PARTIAL
idx_master_companies_visible_revenue     (revenue_min_minor, revenue_max_minor) PARTIAL

-- text legs
idx_master_companies_trgm_domain   USING gin ((primary_domain::text) gin_trgm_ops) PARTIAL
idx_master_companies_trgm_hq_city  USING gin (hq_city gin_trgm_ops)                PARTIAL
idx_master_companies_gin_specialties USING gin (specialties)                       PARTIAL

-- HQ region (the country → state → city cascade)
idx_master_company_locations_hq    (master_company_id, region) WHERE kind = 'hq'
```

**Already present — do NOT re-create** (verified):

| Index | From |
|---|---|
| `idx_master_companies_trgm_name` | `0123` |
| `idx_master_companies_industry_id` | `0128` |
| `idx_master_companies_org_kind` | `0108` (partial on `<> 'company'`) |
| `uniq_master_companies_primary_domain` | schema |

**The citext trap.** `primary_domain` is `citext`, and `gin_trgm_ops` is defined over
`text` — citext is not binary-coercible to it, so `gin (primary_domain gin_trgm_ops)`
does not merely go unused, it **fails to create** ("no default operator class"), which
would break every `migrate` run. It must be indexed as the `(primary_domain::text)`
expression, and the repository query must cast identically — an expression index is
only consulted when the query's expression matches textually. `0081` records the same
trap for `contacts.email_domain` and `accounts.domain`. Keep the two byte-in-step.

## `0135_database_people_filters.sql` — the People tab's new filters

```
-- employer join filter (title + company-firmographic combinations)
idx_master_persons_visible_company    (current_company_id)   PARTIAL on MASTER_PERSON_VISIBLE

-- phone line type (mobile vs direct-dial → S-04)
idx_master_phones_person_line_type    (master_person_id, line_type)

-- attribute EXISTS filters
idx_master_person_skills_skill        (skill)
idx_master_person_languages_name      (name)
idx_master_education_school_norm      (school_name_normalized)
idx_master_education_fields_gin       USING gin (fields_of_study)

-- years-of-experience / years-in-role / recent-job-change source
idx_master_employment_person_started  (master_person_id, started_on) WHERE is_primary
```

## Materialized derivations — `0136`, optional, stage 5

Three Phase-1 filters are classed **Derivable**, and all three are too expensive to
compute per row at query time (an aggregate or a regex over every candidate is
unindexable). Each becomes a nullable column on `master_persons`, written at landing
and backfilled once:

| Column | Derived from | Unlocks |
|---|---|---|
| `title_function varchar(30)` | `job_title` via the existing `titleFunction` taxonomy in `packages/types/src/search.ts` (14 values) | Department / function filter |
| `career_started_on date` | `min(master_employment.started_on)` **excluding the `'-infinity'` sentinel** | Years of experience |
| `primary_started_on date` | the primary stint's `started_on`, sentinel excluded | Years in current role · Recent job change (**S-13**) |

Plus their partial indexes on `MASTER_PERSON_VISIBLE`.

> **The sentinel is a live correctness hazard.** `master_employment.started_on`
> defaults to `'-infinity'`, meaning *"start unknown"* — it exists so the dedup unique
> `(person, company, started_on)` collides for unknown starts. Treating it as a real
> date makes every such person read as ~2000 years of experience and as "changed job
> 700,000 days ago". Both the backfill and the landing writer must exclude it
> explicitly, and the itest must assert a sentinel row produces `NULL`, not a number.

Write path: `landSourcePayload.ts` recomputes all three after
`promotePrimaryEmployment` (it is already inside that transaction and already holds
the primary stint). Backfill: a bounded keyset sweep in `apps/workers`, batched, with
its own runbook line — not a single `UPDATE` over the whole table.

**These three are severable.** If `0136` is cut for time, the three filters are simply
not rendered — the Phase-1 rule holds and nothing ships empty.

## Rollback

- **Indexes** — `DROP INDEX CONCURRENTLY IF EXISTS <name>` for each. Safe for
  correctness; costly for performance (each filter reverts to a heap scan of the
  visible population).
- **Columns** — the `0136` columns are nullable and additive; the rollback is to stop
  reading them (the feature gate), never a `DROP COLUMN`.
- **Feature gates** — see `05-rollout-and-risks.md`. The runtime kill switch is the
  gate, not a migration.

## Verification (Phase 4)

Per the brief: confirm indexes are actually used, do not assume.

- `EXPLAIN (ANALYZE, BUFFERS)` for each of the heaviest filter combinations, captured
  in the PR description:
  1. text + seniority + industry (people)
  2. title contains + employer headcount range (people, crosses the company join)
  3. industry + hq_country + employee range (companies)
  4. name/domain fuzzy + revenue range (companies)
  5. each of the four cursor orders, page 1 and a deep page
- Pass condition: a **Bitmap Index Scan** or **Index Scan** on the named index, no
  Seq Scan on `master_persons` / `master_companies`, and no `rows=1` misestimate
  feeding a nested loop (the pathological regime `0133` measured and fixed).
- Run against a realistic volume. `0133` was measured on an 8.25M-contact seed; use
  the same class of seed for the Layer-0 tables, and record the real production row
  counts in the PR (see risk R1 — they are still unknown at spec time).
