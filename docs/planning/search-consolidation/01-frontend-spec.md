# 01 — Frontend Spec

Governed by `truepoint-architecture` (structure) + `truepoint-design` (everything
that renders). Light theme only. WCAG 2.2 AA.

## Route and navigation

| Old | New | Mechanism |
|---|---|---|
| `/prospect` | `/search` | new route; `app/(shell)/prospect/page.tsx` becomes a `redirect()` page, the house pattern already used by `app/import/page.tsx` |
| `/prospect?scope=accounts` | `/search?tab=accounts` | the existing in-page redirect effect is deleted; the redirect page maps the param |
| `/companies` | `/search?tab=accounts` | `app/(shell)/companies/page.tsx` becomes a `redirect()` page |
| `/companies/[accountId]` | `/search?tab=accounts&account=<uuid>` | redirect page; deep links from signals / lists / contact detail keep working |
| `/companies/markets` | `/search/markets` | route moves; old path becomes a `redirect()` page |

`navConfig.ts`: the `Prospect` destination becomes `{ label: "Search", href: "/search", match: "/search", icon: Search }`. The `Companies` destination is **removed**. `PALETTE_QUICK`'s `act-search` points at `/search`; a new `act-companies` entry points at `/search?tab=accounts` so the command palette keeps a company entry point. `sectionTitleFor()` resolves `/search` to "Search".

Per `references/removal-cleanup.md`, retiring `/companies` is not done until every reference is gone — grep list in `05-rollout-and-risks.md`.

> **Redirect kill-date.** Each redirect page carries the same one-release comment `app/import/page.tsx` uses. They are deleted in the release after cutover.

## Component tree

```
app/(shell)/search/page.tsx                 thin route; force-dynamic (URL-driven)
app/(shell)/search/loading.tsx              route skeleton
app/(shell)/search/markets/page.tsx         moved from companies/markets

features/search/                            NEW feature folder (the shell)
├── index.ts
├── components/
│   ├── SearchPage.tsx                      composition only: drawer + tab + active pane
│   ├── SearchDrawer.tsx                    collapsible rail host (toggle, persistence, responsive)
│   ├── SearchTabs.tsx                      People | Accounts SegmentedControl
│   ├── AppliedFilterChips.tsx              chip row + Clear all (shared by both panes)
│   └── SearchProfileHost.tsx               reads the URL profile param, mounts the right drawer
├── hooks/
│   ├── useDrawerCollapsed.ts               localStorage `tp.search.drawer`, SSR-safe
│   └── useSearchTab.ts                     ?tab= codec, defaults to people
└── searchTabUrlState.ts                    pure codec for ?tab

features/prospect/                          KEPT — the People pane, largely unchanged
└── components/PeoplePane.tsx               NEW: ProspectPage.tsx minus shell/rail/scope logic

features/accounts/                          NEW — the Accounts pane (absorbs features/companies)
├── components/AccountsPane.tsx             grid + header + toolbar
├── components/AccountsFilterPanel.tsx      moved from prospect/AccountFilterPanel, extended
├── components/CompanyProfileDrawer.tsx     database-company profile (DS Drawer)
├── components/AccountProfileDrawer.tsx     owned-account profile (today's CompanyPage content)
├── accountRows.ts                          merge owned accounts + database companies (mirror of databaseRows.ts)
├── databaseCompanyApi.ts                   typed calls to the new global endpoints
├── accountFilterGroups.ts                  moved from prospect, extended
└── hooks/useAccountsSearch.ts              merged engine (owned + global), mirror of useProspectSearch
```

`features/companies/` is deleted; `MarketsBoard` / `PostingsSection` / `useCompany` move into `features/accounts/`. `features/prospect/components/FilterRail.tsx` — dead code since the server-search rewrite, exported but rendered nowhere — is deleted in the same pass.

**File-size rule.** `ProspectPage.tsx` is 569 lines today. Splitting it into `SearchPage` (composition) + `PeoplePane` (grid) + the column definitions in their own module is the point of this refactor, not a side effect. Target 150 lines per file; the column-definition module and `BulkActionBar` are the accepted exceptions.

## The drawer

- Grid shell: `grid-template-columns: 264px minmax(0, 1fr)` collapsed to **`40px` minmax(0, 1fr)`**, not `0`. Collapsed is a *strip*, not an absence: the toggle has to stay in one place or reopening the rail becomes a hunt (the editor activity-bar posture). Built as specced except for this width, which was `0` in the first draft.
- **Toggle**: `TpIconButton` with `label="Collapse filters"` / `"Show filters"`, `PanelLeftClose` / `PanelLeftOpen` from lucide-react, pinned to the rail head. Keyboard-reachable, visible focus ring. `aria-expanded` on the button, `aria-controls` pointing at the rail's id.
- **Persistence**: `localStorage["tp.search.drawer"] = "open" | "collapsed"`. Read in an effect (never during render — SSR mismatch); the server render is always the open state, so first paint matches the majority case and no layout jump occurs for the default user.
- **Animation**: 200ms on `grid-template-columns`, wrapped in `@media (prefers-reduced-motion: no-preference)`.
  > **Deviation, deliberate.** `truepoint-design` interaction rules say motion is `transform`/`opacity` only. A single 264px grid column animating for 200ms does not thrash layout at this scale, and the transform alternative (slide the aside, snap the column) produces a visible gap during the transition. Recorded here rather than silently taken.
- **Responsive** (`apps/web/src/app/globals.css` breakpoints):
  - 769px and up — inline rail as above.
  - 768px and below — the rail becomes an **overlay drawer**: `position: fixed`, full height, `transform: translateX(-100%)` when closed, backdrop, focus trap, `Escape` to close, focus returned to the toggle. Composed from the DS `Drawer` with `side="left"` so the trap/restore is not hand-rolled (design hard rule). Default state on mobile is **closed** regardless of the stored preference.
  - 480px and below — the results grid drops the `address` and `phone` columns.

## Tabs

`SegmentedControl` (DS) with `People` / `Accounts`, hosted at the top of the rail above the filter groups — the slot `FilterPanel` already exposes as `scopeSwitch`.

**Each tab keeps its own state, in one URL:**

| Tab | URL keys | Codec |
|---|---|---|
| — | `tab` | `people` (default, omitted) or `accounts` |
| People | `q`, `sort`, `f` | existing `searchUrlState.ts`, unchanged |
| Accounts | `aq`, `asort`, `af` | existing account codec, extended |

Because both key sets live in the same URL, switching tabs is a pure param write — filters and results for the inactive tab survive, refresh-safe and shareable. Only the active tab issues requests (the existing `enabled` option on both engines; this is why both are mounted and only one fires).

## Filters

Only the Phase-1 **Build now** and **Derivable** rows are rendered. The Deferred set does not appear as disabled UI — it does not appear at all.

**Semantics, stated in the UI.** OR within a facet, AND across facets, exclude is AND NOT. One line of helper copy under the "Filters" heading: `Matches all groups · any value within a group`. (Writing rules: sentence case, no filler, translation-ready — no concatenated sentence.)

**Per-type UX** (all already implemented for People; extended to Accounts):

| Type | Control | Applies to |
|---|---|---|
| Multi-select, high cardinality | `FacetTypeahead` — debounced server `suggest`, min 1 char, keyboard nav, Enter applies, Escape closes | title, company, industry, school, skill, language |
| Multi-select, fixed enum | `TermOptionChips` with live counts | seniority, email presence, ownership type |
| Include / exclude | `TermFacetField` progressive-exclude: include owns the full width, "is not" opens its own labelled block; a value is single-typed (adding to one side removes it from the other) | titles, companies, locations, industries |
| Numeric range | min-max `TpInput` pair via `useDraftRange` (commit on blur, not per keystroke) | headcount, revenue, founded year, years of experience |
| Bucket range | chips backed by `EMPLOYEE_BANDS` | headcount, revenue |
| Boolean | `TpCheckbox` | has email, has phone, mobile phone, exclude already-owned |
| Accordion group | collapsed by default, count badge on the header when the group has active selections | `groupActiveCount` |

**Applied-filter chips.** Today the People rail renders applied values *inline inside each facet section*. The brief asks for a chip row above results. Both ship: `AppliedFilterChips` renders `activeChips(query)` above the grid with per-chip remove and "Clear all"; the row is **hidden entirely when no filters are active** (design hard rule — never render "No filters applied"). The inline values stay, because they are what makes a collapsed accordion legible.

**Debounce.** Free text commits 300ms after the last keystroke (existing). Discrete controls (chips, checkboxes, typeahead selections) commit immediately — debouncing a click is latency with no benefit. Range inputs commit on blur.

## Results grid

`DataTable` from `@leadwolf/ui` — already window-virtualized above its threshold and already the house table. Do not hand-roll one.

- **Sort** — server-side, bound to `query.sort`. People: `relevance | score_desc | created_desc` (existing contract). Accounts: `relevance | name_asc | headcount_desc | created_desc` (existing account contract).
- **Total count** — from the count endpoint, rendered as `12,431 people · 3,180 in your workspace`, and `10,000+` when the server reports `capped`. Never print a loaded page size as if it were the dataset.
- **Pagination** — cursor "Load more" (infinite-scroll class per `large-data.md`; the existing affordance is kept rather than swapped, so already-loaded pages stay in the query cache and scrolling back is instant).
- **Bulk select** — checkbox column. Database rows become selectable for the actions that can address them (add to workspace, add to list after add); reveal and workspace mutations remain restricted to owned rows, disabled with a tooltip reason rather than hidden. "Select all N matching" stays a **criteria** selection handed to the backend, never an enumerated id array.
- **Row click** — opens the profile drawer. Never navigates away (design hard rule).

## Profile: drawer, with a shareable URL

The brief asked for a recommendation between side panel and route. **Recommendation: drawer, addressed by a URL search param.** `truepoint-design` forbids navigating away from a list to show detail; the URL param restores shareability without leaving the route, which is exactly the escape hatch the skill names.

| Row kind | URL param | Drawer |
|---|---|---|
| owned contact | `?contact=<uuid>` | `RecordDetail` (existing, unchanged) |
| database person | `?person=<linkedin_public_id>` | `PersonProfileDrawer` (new) |
| owned account | `?account=<uuid>` | `AccountProfileDrawer` (today's `CompanyPage` content) |
| database company | `?company=<primary_domain>` | `CompanyProfileDrawer` (new) |

`SearchProfileHost` reads whichever param is present and mounts one drawer. Deep links from signals, lists, and contact detail resolve here.

**What a database profile shows** — Layer-0 facts only: identity, headline, current title and employer, location, employment history, education, skills, languages, firmographics of the employer, `has email` / `has phone` presence badges, and provenance/confidence. **It shows no workspace-overlay facts at all** — no owner, no stage, no tags, no activities, no notes, no reveal state. Those render only when the record is in the caller's workspace, at which point the owned-record drawer is what opens. This is not a UI choice; it is the ownership boundary (`truepoint-data` ownership-and-sharing) made structural — Layer-0 has no workspace column, so the global drawer has nothing workspace-scoped to leak.

**Actions on a database profile** — `Add to workspace` (primary), `Copy profile URL`, `Open on LinkedIn`. Reveal is **not** offered until the record is in the workspace; the reveal path is unchanged and stays credit-gated.

## States

Every pane and every drawer section goes through `StateSwitch` — loading, empty, error, populated — wired at build time, never a hand-rolled `if (loading)` chain.

- **Skeletons** match result shape (`TableSkeleton` for grids, a field-shaped skeleton for drawer sections) so arriving data causes no layout shift.
- **Empty, no filters** — "Search the TruePoint database" with a short line on what the tab searches.
- **Empty, filters active** — "No matches" plus "Adjust your filters" plus a `Clear all` button. Never a dead end.
- **Empty because the global database is unpopulated** — an honest state, not a generic "no matches": the `/imports` precedent (`ImportsNotEnabledError` to "not enabled yet"). See risk R1.
- **Error** — `ErrorState` with `onRetry` bound to the query's `refetch`. A failed global half must never break the owned half; the two run as separate queries precisely so one can fail alone (existing behaviour on People, mirrored on Accounts).
- Filter edits keep the previous rows on screen (`keepPreviousData`) rather than strobing to a skeleton.

## Client state and query keys

Server state lives in TanStack Query hooks only — never `useState`. Query keys are declared once per feature in `keys.ts`, hierarchical:

```
["search", "people",     "results" | "count" | "facets", queryHash]
["search", "database",   "people",    "results" | "count", queryHash]
["search", "database",   "people",    "profile",  slug]
["search", "accounts",   "results" | "count" | "facets", queryHash]
["search", "database",   "companies", "results" | "count", queryHash]
["search", "database",   "companies", "profile",  domain]
```

Invalidation stays narrow — the `AddToWorkspaceButton` precedent (invalidate the five affected families, never the `["prospect"]` root, which used to refetch dozens of unrelated requests for a one-row move).
