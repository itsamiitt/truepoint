# 05 — Rollout, Risks, and the Pre-Build Reasoning Summary

## Pre-build reasoning summary

Run per `truepoint-architecture/references/pre-build-thinking.md`. Only the answers
that changed a decision are recorded; the rest were unremarkable.

**Source of truth.** Postgres. Layer-0 (`master_*`) owns the global population;
`contacts`/`accounts` own the workspace overlay. They are never two sources for the
same fact — the overlay carries a bridge (`master_person_id` / `master_company_id`)
and the graph never carries workspace state. The **URL** is the source of truth for
search state (existing, kept); **localStorage** owns exactly one thing, the drawer's
collapsed preference, which is presentation-only and safe to lose.

**Failure modes.** The global half and the owned half are separate queries by design,
so a slow or failed global search contributes nothing rather than breaking the grid —
existing People behaviour, mirrored on Accounts. Redis down degrades to the loader
(fail open), never an error. A Layer-0 read failure surfaces as `ErrorState` with
retry on that pane only. The one genuinely new mutation path is unchanged
(`from-database`), which is already rate-limited and idempotent at the DB via
`uniq_contacts_ws_linkedin`.

**Duplicate prevention.** No new create path, so nothing new to de-duplicate. The
merged grid's dedup key is `linkedin_public_id` for people and the PSL registrable
domain for companies — see risk R7 for where that key is weak.

**Audit.** Reads, not mutations. Profile reads are structured-logged and metered but
do not enter `platform_audit_log`, consistent with how search reads are treated
today. Called out in `04` so it is a decision, not an omission.

**Security.** Full treatment in `04-permission-changes.md`. The two findings that
changed the design: the `leadwolf_app` REVOKE wall (which forced the two-transaction
shape and the filtered-keyset correction) and the enumeration surface the new profile
routes create (which forced the rate limits into scope rather than "later").

**Scalability.** Every list is cursor-paginated with a hard `limit` max; every filter
is index-backed by `0134`/`0135` or it is not shipped; counts are capped so their cost
is bounded; the grid is window-virtualized above its threshold. The `OVERFETCH` factor
is bounded at 300 rows so "exclude my workspace" cannot become an unbounded scan.

**Rollback.** Two env gates (below) turn the new halves off at runtime with no deploy.
Migrations are expand-only — the rollback for a column is to stop reading it, never
`DROP COLUMN`.

**Worst case.** *A workspace's private data becomes visible to another tenant through
the new global surfaces.* Structurally prevented: Layer-0 holds no workspace column,
`private`-visibility rows (which is what every workspace-minted person is) are
excluded by the predicate inside every read, and the only workspace-scoped fact in
the response is the caller's own `inWorkspace` flag, produced under RLS. Detectable
by the cross-tenant isolation itest that is a required deliverable of stage 2 (see
Testing). Second worst case: *the enumeration walk* — bounded by rate limits and
worthless without channel values, both covered in `04`.

## Risk flags

| # | Risk | Status |
|---|---|---|
| **R1** | ~~The global database may be empty in production.~~ **RESOLVED 2026-08-21 — measured, see the population table below.** The graph is live and growing but **very young**: 176 sellable people, 231 landed companies, first landing 2026-08-18. | **No longer blocking.** Stage 2 is architecturally correct and ships over a small population that grows ~100 rows/day. The two consequences are R1a and R1b. |
| **R1a** | **The People tab's global half is 176 people** — 9,591 of 9,767 `master_persons` are `private` (workspace-minted, correctly excluded by the co-op boundary). Users will see almost nothing from the database half on the People tab. | Accepted. Not a bug: it is the co-op boundary working. Grows with ingestion. |
| **R1b** | **Ingestion is throttled, not broken.** The single `linkedin_api` origin ("expo") shows `consecutive_failures: 5`, `last_error: "http 429"`, and `last_ok_at` minutes before the census. It lands successfully between throttles. | Operational, not in this work's scope. Belongs to the ingestion runbook. Worth an alert if `consecutive_failures` stays non-zero across a window. |
| **R2** | Profile endpoints are an enumeration surface. | Mitigated — rate limits + logging + alert, in scope. See `04`. |
| **R3** | `MASTER_COMPANY_VISIBLE` excludes 20 landed companies that have no domain yet (251 → 231). | Accepted and documented. `fillCompanyPrimaryDomain` closes it on the next company document. **Note the first draft of this predicate was wrong** — domain-only admitted 3,747 rows of which 94% were blank minted stubs; see `02-backend-spec.md`. |
| **R4** | This reverses D-9 (the MI-1 IA regroup) ratified in `decisions.md` 2026-08-19. | Requires the `decisions.md` entry below, landed in the same change as the nav rename. CLAUDE.md rule 6. |
| **R5** | Capping the global counts changes `databaseCountResult`. | Additive (`capped` defaults `false`), same version. Non-breaking. |
| **R6** | In "All" mode the merged grid is two concatenated sorted lists — owned rows always sort above global ones. | Existing People behaviour, inherited. Mitigated by a labelled divider + the two single-population modes. Not fixable without bridging every owned record or breaking the role wall. |
| **R7** | Merging owned accounts with database companies needs a dedup key. `accounts.master_company_id` is authoritative when bridged; unbridged accounts fall back to domain, and a spelling difference double-renders a company. | Mitigated by normalising both sides through the existing `registrableDomain` (PSL) helper. Residual: an account with no domain at all cannot be matched and will render separately. Documented in `accountRows.ts`. |
| **R8** | `master_persons.department`, `location_country`, `location_city` have no writer and are always NULL. | **Do not build those filters.** Phase-1 rule. Department is reachable only via the `0136` `title_function` derivation. |
| **R9** | Retiring `/companies` risks orphaned references (signals rows, list links, contact detail, palette, tests). | `references/removal-cleanup.md` grep checklist below is a required stage-4 deliverable. |
| **R10** | Four Layer-0 subsystems have schema + repo writers but **no production caller** (technographics, funding, job postings, company contact points). | Out of scope, listed as the enrichment roadmap below so nobody re-discovers them as "missing tables". |

## Production population — measured 2026-08-21 (read-only census)

The census that closed R1. Re-run it before stage 2 review; these numbers move daily.

| Table / population | Rows |
|---|---|
| `contacts` (workspace overlay) | 9,634 |
| `accounts` (workspace overlay) | 3,537 |
| `master_persons` — all | 9,767 |
| `master_persons` — `private` (workspace-minted, never sellable) | 9,591 |
| **`master_persons` — visible (`licensed`)** | **176** |
| `master_companies` — all | 4,427 |
| `master_companies` — `org_kind='company'` | 4,189 |
| `master_companies` — + domain (the rejected first-draft predicate) | 3,747 |
| **`master_companies` — visible (adopted predicate)** | **231** |
| `master_employment` | 10,732 |
| `master_emails` / `master_phones` | 7,969 / 12 (0 mobile) |
| `master_person_skills` / `master_education` / `master_person_languages` | 6,814 / 364 / 141 |
| `master_company_headcount` points | 6,171 |
| `master_company_locations` | 233 |
| `master_signals` | 3 |
| `master_industries` (the `0128` seed) | 24 |
| `master_technology_adoptions` / `master_company_funding` / `master_job_postings` | **0 / 0 / 0** |

Field population on the 231 visible companies: industry 231, ownership_type 228,
description 228, employee_count 229, logo 226, hq_country 220, hq_city 219, revenue
215, specialties 167, industry_id 140, year_founded 144.

Field population on the 176 visible people: job_title 176, headline 176, location_raw
176, seniority 161, current_company 136, has_email 35, has_phone 9,
**department 0, location_country 0** — confirming R8 from live data.

The three zero-row tables confirm the Phase-1 **Deferred** classification from the
data side, independently of the "no production writer" finding from the code side.

**Growth**: first landing 2026-08-18. Companies landed per day 25 / 91 / 126 / 9;
licensed persons per day 20 / 26 / 130. The graph is four days old.

## Bundle budget — measured, not assumed

The perf-checklist target is **200kB First Load JS** per route (PA-2 brought `/lists` and `/companies`
under it). `/search` hosts two panes, so it needed the same discipline.

| Shape | `/search` First Load JS |
|---|---|
| Both panes statically imported | 214kB — **over target** |
| **People eager, Accounts `next/dynamic`** | **197kB** ← shipped |
| Both panes `next/dynamic` | 117kB |

The third row is tempting and wrong. PA-3 defers things behind an **intent** — the Cmd-K palette, a wizard
dialog, the bulk bar. The People pane is not an intent, it is the page: it renders on essentially every
visit, so deferring it buys 80kB with a round trip on the critical path *before the first search can even be
issued*. Accounts is a real intent (a tab the visitor chooses), so its grid, filter panel and the two
profile drawers stay out of the default load.

Two supporting moves, both PA-2/PA-3 shapes:
- `features/{prospect,accounts}/entries/pane.ts` — a dynamic import of a feature's MAIN barrel splits
  nothing, so the pane needs a one-symbol entry or the whole 86-file slice rides along.
- `SearchProfileHost` loads both profile drawers via `next/dynamic`; they are only reachable on a row click.

Query hygiene follows PA-8: profile reads are `staleTime` 5min / `gcTime` 10min, so reopening a row the rep
just looked at is instant rather than a round trip.

## Feature gates

House posture, matching `BULK_IMPORT_ENABLED`: explicit-`"true"`-only, so
`"false"` / `"0"` / `""` / unset can never read truthy.

| Gate | Guards | Default |
|---|---|---|
| `DATABASE_COMPANY_SEARCH_ENABLED` | the Accounts tab's global half + `N3`/`N4` routes | off |
| `DATABASE_PROFILE_ENABLED` | the two profile routes `N1`/`N2` and the un-gated row click | off |

Gate-off behaviour is **honest degradation, not breakage**: the Accounts tab shows
owned accounts only; a database row click does nothing, exactly as today. Both routes
404 while off, which is also the enumeration-safe answer.

The rename, the drawer, and the tab shell ship **ungated** — they are pure UI with no
new data path, and the rollback is a revert. Gating a nav label would be theatre.

Both gates and their `.env.example` entries are added with the code, per
`references/feature-flags.md`, each with a written removal condition (delete the gate
once the cohort is at 100% and the honest-empty path has been exercised).

## Phase 3 — stages, each independently reviewable

| Stage | Deliverable | Gate |
|---|---|---|
| **1 — DONE 2026-08-21** | Rename `/prospect` → `/search`; redirect pages; `navConfig` + palette + `sectionTitleFor`; the collapsible drawer (toggle, persistence, responsive overlay); the People/Accounts `SegmentedControl` wired to `?tab`; `SearchSurface`/`PeoplePane`/`AccountsPane` split; `features/companies` → `features/accounts`; delete dead `FilterRail`. **No new filters, no new endpoints.** | ungated |
| **2 — DONE 2026-08-21** | Global company search end-to-end: `MASTER_COMPANY_VISIBLE`, the two repositories, `0134`, contracts, `N3`/`N4`, `AccountsPane` merging owned + database rows, counts, sorting, pagination. R1 resolved first (census). Deviations: the facets route ships alongside search/count; both global counts are now capped (`DATABASE_COUNT_CAP` lives in the contract); `lib/problemMessage` gained `problemMessageFromBody` so the typed-`ApiError` callers stop re-deriving the precedence. | `DATABASE_COMPANY_SEARCH_ENABLED` |
| **3 — DONE 2026-08-21** | Un-gate profiles: `N1`/`N2`, the two drawers, `SearchProfileHost` + the `?person=`/`?company=` params, the `rl:dbprofile` enumeration limiter, add-to-workspace demoted to one action on the profile. Deviations: the profile DTOs gained `hasMobile` (an EXISTS, serving **S-04** without giving the number away); the drawers derive headcount growth client-side from the series rather than adding a stored field (the 0114 posture); the Accounts pane is now `next/dynamic` — see the perf note below. | `DATABASE_PROFILE_ENABLED` |
| **4** | Remaining Build-now filters + include/exclude on the global contracts, applied-filter chip row, Clear all, workspace-status control, `0135`. Retire `/companies` for real — the removal-cleanup grep sweep. | — |
| **5** | Derivable filters: `0136` + the landing writer + the backfill worker (department/function, years of experience, years in role, recent job change). CSV export for the Accounts tab. `EXPLAIN ANALYZE` pass against the index plan. | — |

Stage 5 is severable. If it is cut, its four filters are simply not rendered.

## Testing (wired at build time, not after)

- **Cross-tenant isolation itest** — mandatory (`truepoint-architecture` testing, and
  the standing gap that no per-endpoint isolation test exists yet). Assert that
  workspace A's `inWorkspace` probe never returns workspace B's `accountId`/
  `contactId`, and that a `private`-visibility person is 404 on `N1`.
- **Visibility-predicate itests** — a `school`, a domainless stub, a suppressed
  person, and a merged person each absent from search, count, and profile. Assert the
  **specific** SQLSTATE or the specific absence, and assert the probe itself ran — a
  test that passes for the wrong reason is worse than none (`0121`-era lesson).
- **Filtered-keyset itest** — with "exclude my workspace" active over a page where
  every candidate is owned: assert no row is skipped and none duplicated across the
  full cursor walk. This is the correction in `02` §Pagination; it is exactly the bug
  that is silent without a test.
- **Sentinel itest** — a `'-infinity'` employment start yields `NULL` years of
  experience, not a number (stage 5).
- **Pure unit tests** — the filter-group codecs, the merge/dedup in `accountRows.ts`,
  the URL codecs, the band derivation. All pure modules, all cheap.
- **Never `expect(...).rejects` on a rejected DB call** — house rule; use explicit
  try/catch that returns the error, or the itest pool (`max: 1`) hangs.
- **Every `beforeAll` that provisions a database gets `}, 180_000)`** and an
  optional-chained teardown.
- Itests run in **CI** (Postgres + Redis). Local green is not CI green — push the
  branch and verify with `gh run watch`.

## Removal-cleanup grep checklist (stage 4)

Not done until every one of these returns only the redirect pages:

```
rg -i "features/companies"
rg -i "/companies"                 # routes, links, hrefs, tests, docs
rg -i "CompaniesIndexPage|CompanyPage|MarketsBoard|useCompany"
rg -i "scope=accounts"
rg -i "AccountFilterPanel|useAccountSearch|accountFilterGroups"   # moved, not deleted
rg -i "FilterRail"                 # deleted
rg -i "/prospect"                  # links, palette, deep links, docs, extension
```

Then `bun run typecheck` (which runs `typecheck` **and** `typecheck:tests`),
`bun run lint`, `bun run lint:boundaries`, `bun test`, and regenerate the
architecture map (`bun run arch:map` — it is in biome's ignore list, so it will not
break `biome check`).

Also update, because they name the retired surface: `docs/ARCHITECTURE_MAP.md`,
`docs/planning/market-intelligence/07-product-surfaces.md`,
`docs/planning/11-information-architecture.md`, and
`docs/planning/24-advanced-search-exploration-ux.md`.

## Deferred — the enrichment roadmap

Each is **schema-complete with a working repository writer that nothing calls**.
Turning one on is "wire a producer", not "design a subsystem". Ordered by product
value:

1. **Technographics** — `masterTechnologyRepository.recordDetection` → Technologies filter on both tabs.
2. **Job postings** — `masterJobPostingsRepository.upsertPosting` → hiring-activity filter (the *reads* are already wired into `/accounts/:id`).
3. **Funding** — `masterCompanyDetailRepository.recordCompanyFunding` → stage / raised / last round / investors.
4. **Email verification write-back to Layer-0** — `master_emails.email_status` is only ever its DEFAULT today → verified-vs-unverified filter. Serves **S-08**.
5. **Location parsing** — `location_raw` → country/state/city → the person-location cascade.
6. **Sub-industry + NAICS/SIC** via `master_company_identifiers`.
7. **Seniority vocabulary** — 6 rungs → the 9 the taxonomy asks for (new enum + re-inference + backfill).

Commercially blocked items (D-4 funding feed, D-5 technographics feed + C4 GPL
clearance, D-6 postings feed) are unchanged by this work — see `decisions.md`
2026-08-19. No code here assumes them.

## `decisions.md` entry (draft — lands with stage 1)

> ## 2026-08-21 — Search consolidation; Accounts searches the global graph (operator decision)
>
> The operator directed that `/companies` be retired and both prospecting surfaces
> fold into one **Search** destination (`/prospect` → `/search`) with People and
> Accounts as tabs inside a collapsible filter drawer, and that the Accounts tab
> search the **global** company graph (`master_companies`) rather than the
> workspace-scoped `accounts` table ("not the companies which are part of someone's
> uploaded list"). Workspace accounts remain visible on the same tab as a *state of a
> row*, mirroring how the People tab already merges owned contacts with database
> people.
>
> This **partially reverses D-9** (the MI-1 IA regroup ratified 2026-08-19), which
> split account search out to its own `/companies` destination. D-9's other
> provisions (the signal feed, watchlists, the markets board) are unaffected; only
> the account-search destination is folded back. Recorded per rule 6.
>
> Two consequences recorded with it:
>
> (a) **A company visibility policy now exists.** `MASTER_COMPANY_VISIBLE`
>     (`org_kind = 'company' AND primary_domain IS NOT NULL`) is the company twin of
>     `MASTER_PERSON_VISIBLE`, applied inside every Layer-0 company read, with the
>     `0134` partial indexes built on the same predicate. It excludes minted school
>     nodes and domainless stubs, and makes `primary_domain` the URL-shaped
>     addressing key — the D4 posture extended to companies.
>
> (b) **Add-to-workspace is no longer a prerequisite for viewing a profile.** Any
>     authenticated user may read the masked Layer-0 profile of any visible person or
>     company. Channel values remain paid, reveal remains workspace-scoped and
>     credit-gated, and no workspace-overlay fact is served on a global profile —
>     A-01/A-03 and the co-op boundary are unchanged. The new profile routes are
>     rate-limited as enumeration surfaces.
>
> Spec: `docs/planning/search-consolidation/`.

## What this pass is explicitly NOT doing

- Not touching `apps/admin`, `apps/forge*`, `apps/extension`, or the enrichment
  waterfall.
- Not building any filter without data behind it (the seven deferred items above).
- Not granting `leadwolf_app` any access to `master_*`.
- Not changing reveal, credits, entitlements, or pricing.
- Not dropping or renaming any column; no destructive migration.
- Not replacing Postgres search with an engine. The trgm posture stands, with the
  engine adapter as its documented kill-date successor (`0081`/`0123` headers,
  `decisions.md` 2026-08-18 D10).
- Not retiring the markets board — it moves to `/search/markets`.
- Not adding a dependency. Everything uses what is already in the tree.
