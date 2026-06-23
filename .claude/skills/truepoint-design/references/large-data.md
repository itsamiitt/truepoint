# Large Data — Tables, Lists, and Performance Budgets

TruePoint is a data product: reps work over lists of thousands of prospects and
search a dataset of hundreds of millions. A table built the naive way — render every
row as a DOM node — mounts thousands of nodes, janks on scroll, and eventually
freezes the tab. This file is how data surfaces stay fast at scale. It pairs with
**truepoint-platform** api-contract (cursor pagination) and **truepoint-data**
search-infrastructure (the index that serves big queries).

---

## Never Render an Unbounded List

The core rule: **the DOM holds only what's visible, and the client holds only a
page** — never the whole dataset.

- **Virtualize long lists/tables.** Use windowing (a virtualization library) so only
  the rows in (and near) the viewport are in the DOM, regardless of how many rows the
  result has. Scrolling recycles nodes; the node count stays roughly constant.
- **Paginate on the server.** The client fetches a page at a time via the cursor
  contract (see **truepoint-platform** api-contract) — it never asks for "all rows".
  `DataTable` consumes pages; `Pagination` or infinite-scroll drives fetching the
  next cursor.
- **Combine them**: virtualization handles *rendering* a large fetched set smoothly;
  server pagination handles *not fetching* an unbounded set in the first place. Both
  are needed — virtualization alone still downloads everything; pagination alone
  still renders a whole page of potentially hundreds of rows.

A `DataTable` that maps over an unbounded array with no windowing and no pagination
is the anti-pattern the lint/review should catch.

---

## Pagination vs Infinite Scroll

| Use | When |
|---|---|
| **Infinite scroll** (fetch next cursor on scroll-near-bottom) | Browsing/scanning a list where the user works top-down (a prospect list, search results). The natural default for exploratory data. |
| **Explicit pagination** (`Pagination` prev/next) | When the user needs a sense of position/total, or to jump around, or for dense admin tables where infinite scroll disorients. |

Either way the data comes a page at a time by cursor. Don't load page 2 until it's
needed; keep already-loaded pages in the query cache (architecture state-and-data) so
scrolling back is instant.

---

## Filtering and Sorting Happen Server-Side

At scale, filtering/sorting a large set on the client is impossible — the client
doesn't have the full set.

- Filters and sorts are **query parameters sent to the server** (or the search
  index), which returns the filtered/sorted page. The faceted filter bar drives the
  query; it does not filter an in-memory array (see **truepoint-data**
  search-infrastructure).
- The result count shown for a big filtered query may be **approximate** (from the
  index) — that's expected; exact counts that matter come from the source of truth
  (platform data-platform).

---

## Bulk Selection at Scale

"Select all" over a virtualized, paginated list is a known trap — you can't select
DOM rows that aren't rendered.

- **Selection is by identity/criteria, not by DOM row.** Track selected IDs, or
  represent "all matching the current filter" as a *criteria* selection (a filter
  description), not an array of every row.
- A bulk action on "all 40,000 matching" sends the **filter/criteria** to the
  backend, which performs the action as a **job** (see **truepoint-platform**
  async-jobs) — the client never enumerates 40,000 rows to act on them.
- Show selected count and let the user distinguish "the 50 I ticked" from "all
  40,000 matching the filter" — they're different operations.

---

## Performance Budgets

"Millions of users" on varied devices/networks means the frontend has budgets, not
just correctness:

- **Bundle**: routes are code-split (Next.js per-route, and the `@leadwolf/ui`
  package model — see the design skill) so a user downloads the code for the surface
  they're on, not the whole app. Watch route bundle size; a heavy dependency pulled
  into a common route is a regression.
- **Core Web Vitals are targets**: a good **LCP** (fast first meaningful paint),
  low **INP** (interactions respond quickly — critical for a daily-driver tool), and
  low **CLS** (no layout jumps — which is why numeric values use tabular figures and
  skeletons match content shape; see tokens.md, interaction.md).
- **Skeletons match the result shape** (interaction.md) so data arriving doesn't
  shift layout.
- **Avoid render storms**: a large list re-rendering every row on every keystroke of
  a filter is a budget failure — debounce filter input, and keep row components from
  re-rendering when their data hasn't changed.

Budgets are checked, not assumed — regressions in bundle size or vitals on key routes
are treated like any other regression.

---

## Checklist

- Is every long list/table virtualized (constant DOM node count) AND server-paginated
  by cursor (never fetching the whole set)?
- Do filtering and sorting run server-side / via the index, not over an in-memory
  array?
- Is bulk selection by ID/criteria (with "all matching" as a criteria selection), and
  do bulk actions run as backend jobs?
- Are routes code-split, with bundle size and Core Web Vitals (LCP/INP/CLS) treated
  as budgets?
- Do skeletons match content shape and do large lists avoid re-rendering every row on
  each filter keystroke?
