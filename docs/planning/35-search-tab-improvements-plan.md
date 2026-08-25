# Search Tab Improvements — Implementation Plan

**Outcomes advanced:** [S-09] [S-10] [S-13] [S-04] [S-08] [A-01]. No new services or search engines — everything extends the existing SearchPort/repository dispatch tables and the declarative filter-group model.

## Context

The Search tab (`apps/web` → `/search`, People + Accounts panes) has three problem areas, all confirmed by code audit:

1. **UI defects & hidden data.** The reported "overlapping UI" is real: the bulk action bar uses `--tp-z-popover` (70) while drawers/dialogs sit at `--tp-z-modal` (60), so with rows selected it paints over the record drawer and its own dialogs. Also confirmed: two grid columns both headed "Email"; a doubled sticky/scrollport in the filter rail; employment/education/signal rows laid out horizontally so text squeezes; an Accounts header that overflows on narrow viewports; drawer values clipping with no tooltip; database-origin rows unmarked in the People grid. Meanwhile large parts of the API payload are never rendered (seniority, department, location, outreach status, data health, last-verified, phone status/line-type on People; sub-industry, HQ, technologies, founded year, ICP score on Accounts).
2. **Employment history repeats the company per role.** `master_employment` already stores one row per (person, company, started_on) stint — a promotion IS a second row at the same company — but every surface renders a flat list, so "Finance Manager, Acme" and "Finance Director, Acme" show as two disconnected rows with the company name twice. No grouping utility exists, and neither API contract ships a company key safe to group on (Layer-0 ids never cross to clients; grouping by display name would merge distinct same-name companies).
3. **Filters incomplete and partly broken.** Shipped controls that do nothing (Do-not-contact is silently dropped at `searchRepository.ts:220`; account bool clauses dropped at `accountSearchRepository.ts:124`); the Accounts "Revenue" control mis-bound to `company_stage` (declared twice, chip mislabeled); backend filters with no UI (`revenue_range`, `is_revealed`, `icp_fit_score`, account sorts); many DB fields not filterable at all (title_function — materialized for this purpose, employment/tenure [S-13], education, skills, phone line type [S-04], data freshness [S-10]); and the **null cliff**: 13 of 20 People filter controls make `toDatabaseQuery` (`databaseRows.ts:37`) return `null`, silently deleting the entire global-database half of results with zero indication.

Phases are independently shippable. Recommended order: **1 → 3a → 2 → 3b → 3c → (3d, gated)**; Phases 2 and 3a can run in parallel.

---

## Phase 1 — UI bug fixes + field visibility (~2–3 days) — [S-10] [S-04] [A-01]

### 1.1 Layout/paint fixes (all verified file:line)

| # | Fix | Where |
|---|-----|-------|
| 1 | Rename glyph column header to "Channels"; keep reveal column as "Email"; align column-chooser label | `apps/web/src/features/prospect/components/PeoplePane.tsx:259-286` |
| 2 | **Overlap bug**: bulk bar drops below modal layer — new `--tp-z-bulkbar` token (between sticky 30 and drawer 40) or reuse a sub-modal layer; fix stale `var()` fallback | `apps/web/src/features/prospect/prospect.module.css:631-636`, `packages/ui/src/tokens.css` |
| 3 | Single scrollport in the filter rail: shell `.railCol` (`search.module.css:24-32`) keeps sticky+overflow; strip sticky/max-height/overflow from FilterPanel `.rail` (`prospect.module.css:21-30`) and AccountFilterPanel equivalent | those files + `FilterPanel.tsx`, `AccountFilterPanel.tsx` |
| 4 | `.timelineItem` → column layout, `min-width:0` + wrapping so Employment/Education/Signals rows stop squeezing side-by-side | `prospect.module.css:588-593`, `EmploymentSection.tsx`, `EducationSection.tsx`, `SignalsSection.tsx` |
| 5 | Accounts header: `flex-wrap` + `min-width:0` on the input in `.indexHead`; delete dead `.searchInput`; move 900px breakpoints to canonical 768/480 | `apps/web/src/features/accounts/accounts.module.css:125-130, :55, :115` |
| 6 | Truncation convention: drawers use `word-break` (prospect convention); where ellipsis stays, add `title` attr | `accounts.module.css` `.fieldValue`, `DatabaseProfileDrawer.tsx` |
| 7 | Mark database rows in People grid with the same "In database" `TpChip` AccountsTable uses (restores what `WorkspaceScopeControl.tsx:13` documents but was never built) [A-01] | `PeoplePane.tsx` row renderer |
| 8 | QuickViewDrawer: relabel `emailDomain` "Domain" (currently "Company", disagreeing with the grid); wire or remove dead `onOpenLinkedin` in RowActions; fix DatabaseProfileDrawer experience React key (append index) | `QuickViewDrawer.tsx:83`, `PeoplePane.tsx:308-313`, `DatabaseProfileDrawer.tsx:130` |
| 9 | Honor `density` in AccountsTable (currently `void density`) | `apps/web/src/features/accounts/components/AccountsTable.tsx:129` |
| 10 | Honest cap caption: "Top 50 database results shown" while global pagination is undecided (see D1) | `useProspectSearch.ts` / pane footers |

### 1.2 Field visibility (extend existing systems, don't rebuild)

- **People grid** — extend `TOGGLEABLE_COLUMNS` (`PeoplePane.tsx:92-98`): seniority, department, location, outreach status, owner, created, **last verified + data-health freshness [S-10]**, phone status + **line type [S-04]**, channel counts. PeoplePane is 600 lines (150-line guideline) → extract column defs/cells to new `features/prospect/components/peopleColumns.tsx`, shrinking PeoplePane.
- **Accounts grid** — add toggleable columns: subIndustry, HQ country/city, technologies, foundedYear, icpFitScore, created; extract to `features/accounts/components/accountColumns.tsx`.
- **DatabasePersonProfileDrawer** — render seniority, location city/country, companyDomain, companyIndustry, updatedAt; education dates alongside degree. (Per-stint fields land with Phase 2's grouped renderer.)
- **Company rows/drawer** — stop discarding `description, logoUrl, websiteUrl, linkedinCompanyUrl, specialties, ownershipType, revenue min/max` in `databaseCompanyToRow` (`features/accounts/accountRows.ts:91`).

**Acceptance:** no overlapping paint with rows selected + drawer open; one scrollbar in the rail; no horizontal overflow at 360px; [S-10] last-verified/freshness reachable in ≤1 click from the grid; [A-01] 100% of database-origin People rows visibly marked. **Tests:** columns-registry unit test (every toggleable column has header + renderer); existing `*.test.ts` conventions.

---

## Phase 2 — LinkedIn-style employment grouping (~3–4 days) — [S-09] [S-13] [A-01]

### 2.1 Contract change (required — no safe grouping key exists)

Ship an **opaque per-stint `groupKey`**, computed server-side: salted short hash of `master_company_id ?? ('name:' + company_name_normalized)`. Stable across refetches, leaks no Layer-0 id (security to confirm — D5; per-response ordinal is the fallback).

- `packages/types/src/accountIntelligence.ts:201-226` — `employmentStint` + optional `group_key`; `packages/types/src/databaseProfile.ts` — `databaseEmploymentStint` + optional `groupKey`. Optional fields → old clients unaffected; client falls back to normalized-name grouping when absent.
- `apps/api` — one shared key helper used by both mappers: account-intelligence `routes.ts:494-531` (path A) and the database-profile route (path B).
- `packages/db` — `masterEmploymentReadRepository.listPersonEmployment` and `masterProfileReadRepository.employmentForSlugTx` add `master_company_id`, `company_name_normalized` to their select lists (route layer consumes, never forwards raw ids). No schema change, no new index.

### 2.2 Pure grouping util — new `packages/core/src/employment/`

Follows the `data-health/jobChange.ts` precedent; consumable by web and (later) extension.

- `groupEmployment.ts` — `groupStints(stints) → CompanyGroup[]`: group by `groupKey` (fallback: normalized name); within group `is_current desc, started_on desc nulls last`; groups ordered by best role; per-group tenure span; **phantom-stint dedup** (merge only identical title + overlapping precision-refined dates — doc 33 §A2's refinement caveat); **bare-edge degrade** (group whose only stint has no title/dates collapses to a single company line — the live import path mints such edges); `-infinity` start = unknown.
- `format.ts` — promote the unit-tested precision-aware `datePoint/dateRange/tenure` from `apps/extension/src/ui/panel/intel/format.ts` into core; retire the ad-hoc `span()` (`EmploymentSection.tsx:21`) and `period()` (`DatabaseProfileDrawer.tsx:55`).
- `groupEmployment.test.ts` — promotion sequence (Finance Manager → Finance Director = one block, titles in order), bare edge, phantom dedup, same-name-different-key stays split, key-absent fallback, `-infinity`, multiple concurrent `is_current`.

### 2.3 Shared presentational component — new `apps/web/src/components/employment/`

`EmploymentHistory.tsx` + `EmploymentGroup.tsx` + `employment.module.css` — pure props (`CompanyGroup[]`), no fetching, no `features/*` imports, each file <150 lines. LinkedIn structure: company block (monogram, company name, total tenure) → nested role rows (title, precision-aware date range, location, "Current" badge, confidence/source-count where present [A-01]). Consumed by `EmploymentSection.tsx` (owned contact, snake_case) and `DatabaseProfileDrawer.tsx:125-140` "Experience" (global, camelCase).

**Acceptance:** [S-09]/[S-13] 100% of profiles with ≥2 stints at one company render a single company block with titles in sequence, current role first; promotions (`title_change` kind) appear as consecutive titles in one block; bare-edge groups render one clean line (no "undefined – undefined"). **Tests:** core unit suite above; itest asserting `group_key` present and stable across two fetches (itest rules: no `expect(...).rejects`, `beforeAll` `}, 180_000)`).

---

## Phase 3 — Filter completeness (tiered)

### 3a — Fix broken/mislabeled + null-cliff UX (~1–2 days) — [S-08] [S-04]

1. **Revenue mislabel**: bind the "Revenue" control to the real `revenue_range` facet (backend + counts already exist and are already requested); keep `company_stage` once, correctly labeled — `accountFilterGroups.ts:78-88, :100-106`.
2. **`do_not_contact`**: implement the clause in `searchRepository.ts` (~:220) against `suppression_list` — the shipped control currently does nothing, which is compliance-relevant.
3. **`skill` facet**: hide from `FILTER_GROUPS` until 3d (declared, unimplemented — dead control).
4. **Account bool clauses**: implement dispatch at `accountSearchRepository.ts:124` or remove the controls.
5. **Close the range-field enum** in `packages/types` so a typo'd range field fails Zod instead of silently no-oping.
6. **Facet counts**: add `FACET_EXPR` entries for source/technology/location (people) and technology (accounts), or stop requesting them (`PeoplePane.tsx:89`, `AccountsPane.tsx:42`).
7. **Null-cliff fix (flagship)**: refactor `toDatabaseQuery` (`databaseRows.ts:37`) and `toDatabaseCompanyQuery` (`accountRows.ts:52`) from `Query | null` to `{ query, droppedClauses }`. Add `scope: 'both' | 'workspace-only' | 'database-only'` to the `FacetDef` union in both filter-group files; panels render a per-control "Workspace only" badge; the pane shows an explicit notice ("Database results hidden — N active filters apply to workspace records only") instead of the global half vanishing. Default semantics: drop-with-notice (see D2).
8. **"No dead controls" test gate**: extend `filterGroups.test.ts` / `accountFilterGroups.test.ts` — every FacetDef declares a scope AND has a backend clause implementation. This test would have caught items 2–4.

**Acceptance:** 0 filter controls that alter no query; 0 filters that silently drop the global half (100% badged + noticed); DNC filter provably excludes suppressed rows (itest).

### 3b — Expose already-supported backend filters (UI-only, ~1–2 days) — [S-08]

- People: `is_revealed` bool.
- Accounts: `icp_fit_score` range; a sort control (name_asc / headcount_desc already in the contract, no UI today).
- Global-company-only, with `scope: 'database-only'` (inverse cliff, handled by the same 3a machinery): `hq_region`, `specialty`, `ownership_type`, `revenue_minor` range.
- Files: `accountFilterGroups.ts`, `AccountFilterPanel.tsx`, `accountRows.ts` (pass database-only clauses through), `AccountsPane.tsx` (sort wiring), `filterGroups.ts`.

### 3c — New backend filters on existing columns (~3–5 days) — [S-13] [S-10] [S-04] [S-09]

Each = repo dispatch-table entry + contract key in `packages/types` + FacetDef + narrowing-map scope + facet/suggest support + itest. Migrations use `CREATE INDEX CONCURRENTLY` (follow the master_persons trgm migration precedent).

| Filter | Backing | Repo(s) | Index |
|---|---|---|---|
| `title_function` term + counts | materialized on `master_persons` for exactly this; enum already in `search.ts:38` | `masterPersonSearchRepository` (+ `searchRepository` mirror if desired) | btree `master_persons(title_function)` |
| changed-job-in-last-N-days [S-13] | `master_persons.primary_started_on` | master person repo | btree `primary_started_on` |
| years-in-role / career length | `primary_started_on` / `career_started_on` ranges | same | covered by above |
| verified-recency / freshness [S-10] | `contacts.last_verified_at` | `searchRepository` | partial btree `WHERE last_verified_at IS NOT NULL` |
| mobile-only [S-04] (TCPA-relevant) | `contacts.phone_line_type` | `searchRepository` | verify at implementation |

### 3d — Join-backed filters (1–2 weeks, **gated on human go/no-go — D3**) — [S-13] [S-09]

`EXISTS`-subquery dispatch entries, each its own PR-sized unit: worked-at-company-X (`master_employment.company_name_normalized`, citext — verify index), education (school/degree/fields), skills/languages (restores the 3a-hidden skill facet), is-hiring (`master_job_postings`), funding round/amount/date (`master_company_funding`), technology-adoption recency, headcount growth (`master_company_headcount` — likely needs a materialized growth column, not per-query windows). Suggest-only, **no facet counts** (too expensive). `custom_fields` (GIN index exists for this) + pipeline stage + account family included only if approved (D3). **Excluded:** any `master_signals` recency filter — that's intent data, [X-04] deferred non-goal (D4).

---

## Decisions flagged for the human (defaults chosen, adjust on review)

- **D1 — Global-half pagination**: "Load more" never pages the database half (capped at 50). Real fix = cursor support on `POST /search/database`(+companies) + client merge-pagination. Default: honest caption in Phase 1, pagination backlogged.
- **D2 — Null-cliff semantics**: drop-global-with-notice (default, conservative) vs run global half with the supported filter subset (shows rows not matching all filters — needs product sign-off).
- **D3 — Phase 3d scope**: join-backed filters + custom_fields filtering are planned but gated.
- **D4 — Signals/intent filters excluded** per [X-04] non-goal; confirm no exception intended.
- **D5 — groupKey design**: salted hash (default) vs per-response ordinal — security to confirm no Layer-0 identifier leak.
- **D6 — Phantom-stint merge** could hide genuinely distinct stints; mitigated by the conservative merge rule + showing confidence/source_count [A-01].

## Not doing

New search services/engines; unifying the four filter vocabularies into one registry (deliberate duplication stands — only the shared `scope` metadata is added); migrating the extension UI to the new grouping component (follow-up); signals/intent filters.

## Verification

- `bun run lint` · `bun run typecheck` (covers tests via `typecheck:tests`) · `bun test` (grouping util, filter-group completeness gates, columns registry) · `bun run lint:boundaries` (components/* must not import features/*) · `bun run lint:design-tokens` + `lint:roving-tabindex` for the UI work · `bun run db:migrate` for 3c indexes.
- Itests per phase: `group_key` stability; DNC exclusion; each new 3c filter narrows results (run each `.itest.ts` in its own process; external-Postgres env vars per CLAUDE.md).
- Manual/visual: with rows selected open RecordDetail → bulk bar must be underneath; filter rail single scrollbar; Accounts tab at 360px no horizontal scroll; profile with a promotion (2 stints, same company) shows one company block, two titles in sequence.
