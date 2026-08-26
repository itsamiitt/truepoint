# 00 — Decision and Scope

> Status: **SHIPPED** (stages 1–5, 2026-08-21). Amended 2026-08-25 — see the Superseded note under #4.
> Operator decision date: 2026-08-21. Supersedes the D-9 IA regroup for these surfaces.

## The decision

The operator directed, in session:

1. **Retire `/companies`.** Everything folds back under one destination, renamed
   **Search** (`/search`, was `/prospect`).
2. **One page, two tabs** — People and Accounts — hosted in a collapsible left
   drawer alongside the filters.
3. **The Accounts tab searches the GLOBAL company graph** (`master_companies`,
   Layer-0, source-fetched) — explicitly *not* the workspace-scoped `accounts`
   table ("not the companies which are part of someone's uploaded list").
   Workspace accounts still appear on the same tab, as a *state of a row*, exactly
   as the People tab already merges owned contacts with global database people.
4. **Add-to-workspace stops being a prerequisite for viewing a profile.** Any
   authenticated user may open the full masked profile of any visible person or
   company in the global database. Add-to-workspace remains as an optional action.

   > **Superseded 2026-08-25** (`docs/strategy/decisions.md`): there is no add-to-workspace action any more.
   > The reveal IS the save gesture — `POST /contacts/from-database/reveal` materializes the person and
   > reveals one channel in one request — and `DATABASE_PROFILE_ENABLED` was removed: profiles are simply on,
   > behind the `rl:dbprofile` enumeration limiter. A database person with no licensed channel cannot be saved
   > from Search (accepted; "request contact info" is the named follow-up).

## What this reverses (CLAUDE.md rule 6 — surface, never silently reinterpret)

`docs/strategy/decisions.md` 2026-08-19 adopted **D-9 (IA regroup per
`docs/planning/market-intelligence/07-product-surfaces.md`)**, which split account
search out of Prospect into its own `/companies` destination. The code carries that
decision in three places:

- `apps/web/src/features/prospect/components/ProspectPage.tsx` — the live
  `?scope=accounts` → `/companies` redirect ("CUTOVER (market-intelligence MI-1,
  D-9 regroup)").
- `apps/web/src/features/companies/components/CompaniesIndexPage.tsx` — header note.
- `apps/web/src/components/shell/navConfig.ts` — the `Companies` destination.

**A `decisions.md` entry reversing D-9 for these surfaces is a required artifact of
this work** and must land in the same change as the nav rename. Draft text is in
`05-rollout-and-risks.md`.

## Why the shape is what it is

The People tab already proves the model: `databaseRows.ts` merges workspace
`contacts` with `master_persons` hits into one grid, because *"a sales-intelligence
search is not 'my records' and 'everyone else' on two screens; it is one filtered
list of people, where 'already in my workspace' is a STATE of a row."* The Accounts
tab becomes the same sentence with companies substituted. That is the whole design.

This also satisfies `truepoint-architecture`'s UI-consolidation rule (merge-first:
same domain, same layout, variant-not-page) rather than fighting it.

## Scope

**In scope** — `apps/web` (the Search surface), `apps/api` (search + profile
routes), `packages/types` (contracts), `packages/db` (a new global-company search
repository + a company visibility predicate + index migrations).

**Out of scope** — `apps/admin`, `apps/forge*`, `apps/extension`, `apps/workers`
(except where a queue already exists), the enrichment waterfall, billing, and the
reveal/credit path. No destructive migration: every schema change is additive
(new indexes, optionally new nullable columns). No column is dropped or renamed.

**Explicitly not built** — any filter with no data behind it. See `01-frontend-spec.md`
§Filters and the Phase-1 gap table; the deferred set is an enrichment roadmap in
`05-rollout-and-risks.md`, not empty UI.

## Populations, named once

| Name used throughout | Table | Scope | Key exposed to clients |
|---|---|---|---|
| **owned contact** | `contacts` | workspace, RLS | `id` (uuid) |
| **database person** | `master_persons` under `MASTER_PERSON_VISIBLE` | global | `linkedin_public_id` (URL-shaped) |
| **owned account** | `accounts` | workspace, RLS | `id` (uuid) |
| **database company** | `master_companies` under `MASTER_COMPANY_VISIBLE` *(new)* | global | `primary_domain` (URL-shaped) |

No Layer-0 UUID crosses the API boundary in either direction — the 2026-08-18
decisions entry (D4: URL-shaped identity is the addressing key; numeric ids and
urns stay internal) governs the two new surfaces exactly as it governs the
existing one.
