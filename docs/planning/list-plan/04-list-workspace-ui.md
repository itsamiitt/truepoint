# List Tab — The Lists Workspace UI (04)

> Cites the **Locked Decisions (D1–D5)** and **Shared Vocabulary** in `00-overview.md` and the
> phase/work-unit contract in `09-rollout-phases.md`. This doc owns the **customer-facing surface**:
> the new top-level Lists destination, the list index, and the work-the-list detail view. It is
> **surface + composition**, not new subsystems — the Lists backend, masking, reveal, and bulk-action
> framework already exist (`00 §5`), so the governing rule of this doc is **reuse over rebuild**.
>
> **Scope boundaries (read these first):**
> - **Schema** (lists/list_members columns, RLS, audit, DSAR cascade) → `02-data-model.md`. This doc
>   only *consumes* the DTOs; it does not define them.
> - **Upload/import wizard** (CSV/XLSX, column-map, dedup, preview, receipt) → `03-upload-and-import.md`.
>   Here we only place the **"Import into list" CTA** and the receipt strip; the wizard itself is `03`.
> - **Reveal-from-Prospect → add-to-list** (the fix to the stubbed `RecordDetail` path, bulk add-to-list,
>   select-all-across-search) → `05-prospect-to-list.md`. Here we only place the **"Add from Prospect"**
>   entry and consume members that path produced.
> - **Reveal / enrich / verify mechanics** (match-first → waterfall, credit estimate-before-spend math,
>   credit-back on bounce) → `06-enrichment-verification.md`. Here we render the **trigger, the cost
>   confirm, and the affected-count toast** — never the spend logic.
> - **Staff/admin governance** of list contents → `07-admin-staff-governance.md`. This is a customer
>   surface; staff see metadata-only (D2) elsewhere.
>
> Per `09 §2 Phase 1` this surface ships behind the `lists.tab` feature flag, per-tenant gated.

---

## 1. Navigation & routing

### 1.1 The 7th destination (D3)

`apps/web/src/components/shell/navConfig.ts` is **the single source of truth** for navigation — the rail,
the top-bar section title, the command palette, and the settings scope-nav all read it (its own header
comment says: "add a destination in exactly one place"). Lists is **D3: a new top-level destination**, so
it is added there and nowhere else. Three coordinated edits, all in that one file:

1. **`DESTINATIONS` array** — append a 7th `NavDestination`. Icon from `lucide-react` (the file's existing
   import line), matching the existing visual weight of `Home`/`Search`/`Send`/`Inbox`/`BarChart2`:

   ```ts
   import { BarChart2, Home, Inbox, List, Search, Send, Settings } from "lucide-react";
   // …
   { label: "Lists", href: "/lists", match: "/lists", icon: List },
   ```

   Use `List` (or `ListChecks`) — a flat, single-weight glyph consistent with the rail; do **not**
   introduce a filled/branded icon (design §5). Placement: after **Prospect** in the rail reads as the
   natural "search → collect into a list" flow, but final order is a `truepoint-design` call — the data
   structure supports any position. `match: "/lists"` makes both `/lists` **and** `/lists/[id]` highlight
   the rail entry, because `isActive()` already treats `match` as a prefix (`pathname.startsWith(\`${match}/\`)`).

2. **`sectionTitleFor()`** — Lists is already covered: the function loops `DESTINATIONS` and returns the
   label for any path at/under a destination's `match`, so `/lists` and `/lists/<id>` both resolve to the
   top-bar title **"Lists"** with no extra code. (We only add a manual `startsWith` branch — like the
   existing `/import`, `/enrichment/jobs`, `/sales-navigator` ones — if a list sub-route needs a *different*
   title than "Lists"; none does in Phase 1.)

3. **Command palette** — `PALETTE_NAVIGATE` is generated from `DESTINATIONS`, so adding the destination
   **automatically** gives a "Lists" navigate entry (no edit needed). Add **quick actions** to
   `PALETTE_QUICK` for the two primary jobs so they're keyboard-reachable from anywhere:

   ```ts
   { id: "act-new-list",     label: "New list",         href: "/lists?new=1",   keywords: ["list", "create"] },
   { id: "act-import-list",  label: "Import into list", href: "/lists?import=1", keywords: ["csv","xlsx","upload","list"] },
   ```

   The `?new=1` / `?import=1` query params open the create dialog / import entry on the index (see §2.4) —
   palette deep-links, mirroring how `act-import` points at `/import` today.

> **No other file changes** for nav. The whole point of `navConfig.ts` (its comment: "Replaces the three
> hard-coded copies that used to live in Sidebar.tsx, AppShell.tsx and CommandPalette.tsx") is that the
> rail, top bar, and palette pick the destination up for free. Editing `Sidebar`/`AppShell`/`CommandPalette`
> directly would be a regression.

### 1.2 Routes (App Router, under the `(shell)` group)

The `(shell)` route group wraps every signed-in destination in `AppShell` (rail + top bar + auth gate +
credit pill) via `apps/web/src/app/(shell)/layout.tsx` — the group name is not a URL segment, so routes
inherit the chrome without changing the path. Two **thin** route files, mirroring `prospect/page.tsx`
exactly (the route mounts the feature's public component and nothing else):

| File | Renders | Notes |
|---|---|---|
| `app/(shell)/lists/page.tsx` | `<ListsIndexPage/>` from `@/features/lists` | `export const dynamic = "force-dynamic"` — the index reads filter/sort/`?new`/`?import` from the URL (`useSearchParams`), exactly the reason `prospect/page.tsx` is force-dynamic (avoids the prerender CSR bailout). |
| `app/(shell)/lists/[id]/page.tsx` | `<ListDetailPage listId={params.id}/>` | Also `force-dynamic` (its members table reads density/column/sort state from the URL). The route passes the validated `params.id` down; **the list ID from the URL is never trusted as an access grant** — every read/write is RLS-scoped to the workspace below the app layer (D4). A list ID that isn't in the caller's workspace 404s server-side; the detail page renders `ErrorState`/not-found, never another tenant's data. |

Both files are ~10 lines: import + `dynamic` + default export. All behavior lives in the slice.

### 1.3 The new feature slice — `apps/web/src/features/lists/`

Mirror `features/prospect`'s structure (D3 says "mirroring the `features/prospect` structure"). The prospect
slice splits cleanly into `components/`, `hooks/`, per-domain `*Api.ts` clients, `types.ts`, an
`index.ts` public barrel, and a `*.module.css`. Lists copies that shape:

```
apps/web/src/features/lists/
  components/
    ListsIndexPage.tsx       # the index surface (§2)
    ListCard.tsx             # one list in the index (or a row in table density)
    CreateListDialog.tsx     # name + kind + tags; reused by ?new and empty-state CTA
    ListSettingsMenu.tsx     # rename / duplicate / archive / delete (owner-gated, §6)
    ListDetailPage.tsx       # work-the-list surface (§3)
    ListHeader.tsx           # detail header: metadata + primary actions (§3.2)
    ListMembersTable.tsx     # THIN wrapper composing the prospect DataTable columns (§3.1, §4)
    RemoveFromListDialog.tsx # the one list-specific row/bulk op (§3.3)
    MemberQuickView.tsx      # lightweight member drawer (§3.4)
  hooks/
    useLists.ts              # index data + reload (mirrors useContacts)
    useList.ts               # one list's metadata + members + reload (detail)
    useListMutations.ts      # create/rename/duplicate/archive/delete (optimistic, §7)
  listsApi.ts                # typed fetchWithAuth calls (mirrors prospect/api.ts)
  types.ts                   # presentation helpers + view-model constants (§5)
  index.ts                   # public barrel: export { ListsIndexPage, ListDetailPage }
  lists.module.css           # tokens-only styling (var(--tp-*))
```

**Reused from `features/prospect`, not copied** (see the §4 reuse map): `useBulkSelection`, `BulkActionBar`,
`RowActions`, `ProspectToolbar` (column chooser + density), the `Column<ContactHit>` cell renderers, and the
masking/glyph helpers (`emailGlyphFor`, `maskedEmail`, `displayName`, `dataHealthTone`). Those are imported
across the slice boundary via the prospect `index.ts` barrel (extend it to export the bits §4 needs); we do
**not** re-export domain types — those come type-only from `@leadwolf/types`.

> **`boundaries` lint:** importing from a sibling feature's `index.ts` barrel is the allowed cross-slice
> seam (consistent with how slices already import `@leadwolf/ui` and `@leadwolf/types`). If the boundary
> rule forbids feature→feature imports, the shared pieces (`useBulkSelection`, `BulkActionBar`, `RowActions`,
> masking helpers) move to a small shared location (e.g. `apps/web/src/features/_shared/` or promoted into
> `@leadwolf/ui` if presentational) — decided at build time with `truepoint-architecture`. Either way the
> mandate stands: **compose, don't duplicate.** This is flagged as a build-time decision, not deferred work.

---

## 2. List index surface (`/lists`)

`ListsIndexPage` is the "list of lists" — the seller's bookshelf. It mirrors the prospect surface's
**header + four-state body** discipline but without the faceted rail (the index is a flat, searchable,
sortable collection, not a faceted query).

### 2.1 Layout

- **`PageHeader`** (`apps/web/src/components/PageHeader.tsx`) — the shared `(shell)` destination header
  (memory: use it for any `(shell)` surface). `destination` variant (22px title, no eyebrow), `title="Lists"`,
  `subtitle="Collect, own, and work a book of prospects."`, and the primary CTAs in the `actions` slot:
  - **New list** (`TpButton variant="primary"`, `leftIcon={<Plus/>}`) → opens `CreateListDialog` (§2.4).
  - **Import into list** (`TpButton variant="secondary"`, `leftIcon={<Upload/>}`) → routes to the import
    entry with a list target (the wizard itself is `03`; here it is just the entry point).
- **A toolbar row** under the header: a search `TpInput type="search"` (filter by name, debounced ~300ms like
  the prospect text box) on the left; on the right a **sort** `TpSelect` (Updated · Created · Name A–Z ·
  Members) and the **"My lists"** filter `SegmentedControl` (All · Mine — §6, D4).
- **The body**: a responsive grid of `ListCard`s (or a `DataTable` in a future "table density" toggle — start
  with cards, the data model supports both). Cards read as a quiet, scannable shelf.

### 2.2 What each list shows (the card / row)

Per `09 §Phase 1` ("name, member count, owner, updated") plus the `list_kind` badge from `00 §4` vocabulary.
All fields come from the list DTO (`02-data-model.md`); none are PII:

| Field | Source | Render |
|---|---|---|
| **Name** | `list.name` | Card title, link to `/lists/[id]`. |
| **`list_kind` badge** | `list.kind ∈ {static, dynamic}` (`00 §4`) | `StatusBadge` — neutral tone for **Static**, an accent tone for **Dynamic** (Dynamic ships in `09 §Phase 4`; until then only Static exists and the badge is informational). |
| **Member count** | `list.memberCount` | Mono numeral, `var(--tp-ink-3)` (`"1,204 members"`, pluralized). |
| **Owner** | `list.ownerName` / `Avatar` | `Avatar` + name; "You" when `ownerId === currentUserId()`. Owner is a **filter, not a wall** (D4, §6). |
| **Updated-at** | `list.updatedAt` | Relative ("Updated 3h ago"); full timestamp in `title`. |
| **Source/tags (secondary)** | `list.source`, `list.tags` | Small muted chips when present (e.g. "from import", a tag or two). Provenance detail lives in the detail header (§3.2). |
| **Overflow menu** | — | `ListSettingsMenu` (rename/duplicate/archive/delete), owner-gated (§6). |

### 2.3 The four states (mandatory — `truepoint-design`)

Every async surface renders all four through the **State Kit** (`StateSwitch` + `EmptyState`/`LoadingState`/
`ErrorState` from `@leadwolf/ui`), exactly as `ProspectPage` does. The index wraps its grid in `<StateSwitch>`:

- **Loading** — default `LoadingState` skeleton (or a grid of `Skeleton` card placeholders). Reduced-motion-safe
  (the shared `tp-skeleton` shimmer is opacity-only).
- **Error** — `ErrorState` with `onRetry={reload}` (calm message + "Try again"; no bare red text).
- **Empty (no lists yet)** — a **quiet** `EmptyState` (one muted glyph max, §5): icon `<List/>`,
  title *"No lists yet"*, description *"Create a list to collect and work a book of prospects — start from
  scratch, import a file, or add contacts you find in Prospect."*, and a single primary `action` = **New list**.
  This is the activation moment (`00 §6`), so the copy points at all three core jobs (`00 §2`).
- **Empty (search returns nothing)** — a distinct, lighter empty: *"No lists match '<query>'"* + a "Clear
  search" affordance. Don't reuse the zero-lists empty for a filtered-empty (different user intent).
- **Populated** — the card grid.

### 2.4 Create / rename / delete / duplicate

- **Create** — `CreateListDialog` (foundation `Dialog`): a `TpInput` for **name** (`maxLength` ~120, mirroring
  the bulk add-to-list dialog), an optional **`list_kind`** choice (Static now; Dynamic disabled-with-tooltip
  "Coming soon" until `09 §Phase 4`), and optional **tags/notes** (`02` carries these columns). Opened by the
  header CTA, the empty-state CTA, **and** the `?new=1` palette deep-link (read on mount, then cleared from the
  URL). On success: optimistic prepend to the index + a toast, then navigate into the new list (so the user
  lands on the empty detail ready to add members).
- **Rename** — inline or a small dialog from `ListSettingsMenu`; **owner-gated** (§6). Optimistic name swap.
- **Duplicate** — clones the list's metadata + membership into a new list (server-side copy via
  `listsApi.duplicateList`); useful for "same book, new campaign". The copy is owned by the actor.
- **Delete / archive** — **archive** (soft, `archived_at` per `02`) is the default surfaced action — recoverable,
  matching the prospect "Archive" pattern (reversible, "can be undone later"). **Delete** (hard) is a separate,
  **danger-styled, confirm-required** action behind the same owner gate; the confirm dialog states the
  consequence ("Deleting removes the list and its membership rows; the contacts themselves are not deleted" —
  the DSAR/erasure cascade is `02`/`09 §Phase 5`, not this UI). Both are owner-gated (§6).

### 2.5 The two primary CTAs (the on-ramps)

The header carries the two ways a new list gets populated; both are **entry points only** (the engines are
siblings):
- **New list** → `CreateListDialog` (§2.4).
- **Import into list** → the import wizard targeting a list (`03-upload-and-import.md`). This is the "bring your
  own data" job (`00 §2`). From the index, "Import into list" first asks/creates the target list, then hands to
  `03`'s wizard with that `listId`.

A third on-ramp, **Add from Prospect**, lives in Prospect and on the **detail** header (§3.2), and is fully
specified in `05-prospect-to-list.md`.

---

## 3. List detail surface — *work the list* (`/lists/[id]`)

This is the **work-the-list** surface (`00 §4` vocabulary): a members `DataTable` that is, deliberately, the
**same table the prospect surface renders**, plus the **same sticky bulk-action bar**, plus a list header. Per
`09 §Phase 1`: "members table **reusing** the prospect `DataTable` + `BulkActionBar` + masking + density +
column chooser". The job here is **composition and wiring**, not building a second table.

### 3.1 The members table (reuse the prospect table wholesale)

`ListMembersTable` is a **thin wrapper**, not a new table. A `Member` (`00 §4`) is a `list_members` row linking
to a workspace-visible `contacts` row, so the member's contact projection **is** a `MaskedContact`/`ContactHit`
(same masked DTO the prospect grid uses). Therefore:

- **`DataTable` from `@leadwolf/ui`** renders the rows — same component, same `Column<ContactHit>` definitions.
  We **lift the column array out of `ProspectPage`** (currently an in-component `useMemo` building
  select/name/company/email/address/phone/actions) into a shared `prospectColumns(...)` factory exported from
  the prospect slice, and the lists table calls it. **The masking is identical and free**: the email glyph
  (`emailGlyphFor`), the masked address (`maskedEmail` → `•••@domain`), and the **locked phone** (🔒 "Phone
  hidden until reveal") all come from the reused cells. PII is masked by default here for the exact same reason
  it is in Prospect (§5, D-masking).
- **Select column** — the same header "select all shown" + per-row `TpCheckbox`, wired to `useBulkSelection`
  (reused hook). On the list, **"select all matching" means "all members of this list"** (resolved server-side
  as `{ listId }` instead of `{ criteria }` — see §3.3 and the selection model below).
- **Density** — the same `SegmentedControl` (Comfortable · Compact) driving `data-density` on the page wrapper.
- **Column chooser + sort** — reuse `ProspectToolbar` (it already renders the sort `TpSelect` + the column
  chooser `DropdownMenu` of checkboxes). The list sort options map to the members-list endpoint's sort contract
  (added-at, name, company, email-status — defined in `02`); we pass the list's column/sort set, not a search
  `ContactQuery`.
- **Row click** → opens the lightweight `MemberQuickView` drawer (§3.4); the heavy `RecordDetail` (reveal/edit/
  timeline) is the same one Prospect hands off to — reused unchanged.
- **"Load more"** — same keyset `TpButton variant="secondary"` pattern (`09` notes lists can reach 10k–100k
  members, so the table stays paginated/keyset; never load all members at once — same discipline as the prospect
  grid and `09 §6 Risks`).

A **data-health column** (email/phone status + staleness) is part of `09 §Phase 3` work-the-list; in Phase 1 the
existing email-status glyph + phone-lock already convey health, and Phase 3 adds the staleness/re-verify
affordance (mechanics in `06`).

### 3.2 The list header (metadata + primary actions)

`ListHeader` sits above the table (uses `PageHeader` for the title row, plus a metadata strip below). It carries:

- **Title** — the list name (rename inline, owner-gated §6), with the `list_kind` `StatusBadge`.
- **Metadata strip** — **member count**, **owner** (`Avatar` + name, "You" when self), **updated-at**, **source/
  provenance** (e.g. "from import · 2 files", per `list.source`; surfaces the import receipt link → `03`),
  **tags** (chips), and a one-line **notes** field (editable, owner-gated). These are the list-level fields from
  `02-data-model.md`; none are PII.
- **An import-receipt strip** (when the list has imports) — a compact "Last import: 1,204 rows · 38 rejected ·
  view receipt" row linking to the import history (`03`). Phase-2 affordance; renders nothing in Phase 1.
- **Primary actions** (right side / overflow), each an *entry* into a sibling engine — this surface renders the
  trigger + confirm + result toast, never the engine:

  | Action | Goes to | This doc renders |
  |---|---|---|
  | **Import into list** | `03-upload-and-import.md` | The CTA; pre-targets this `listId`. |
  | **Add from Prospect** | `05-prospect-to-list.md` | The CTA → opens Prospect scoped to "add to *this* list", or an in-place picker. |
  | **Enrich / re-verify** | `06-enrichment-verification.md` | The trigger + the **cost estimate-before-spend** confirm (D5) + the affected-count + post-spend-balance toast. **No spend math here** (`06`). |
  | **Export** | bulk export (existing `bulkExportCsv`) | The confirm dialog (masked, non-PII columns only — revealed PII never exported, per the existing export copy) + the download. **Role-gated** server-side (`09 §Phase 3`). |
  | **Enroll in sequence (handoff)** | sequences engine (separate milestone, `00 §scope`) | A **stubbed handoff** only — the CTA exists, the enroll posts to the existing `bulkEnroll`/`enrollContacts` path, which honestly degrades to "not available yet" (`notBuilt` 404/501) until the outreach engine ships. **No fake enroll** (the slice's existing `notBuilt` discipline). |

  All money-spending actions (Enrich, Reveal, bulk Export where metered) **show cost + estimate before spend**
  (D5) and surface the server-returned affected count — inheriting, not reinventing, the money rules.

### 3.3 Bulk operations (reuse `BulkActionBar`) + remove-from-list

- **`BulkActionBar` is reused wholesale.** It already implements the full Phase-3 bulk surface wired to
  `bulkActionsApi`: **Reveal** (monetized, `BulkRevealDialog`), Add-to-list, Enroll, Assign/clear owner,
  Add/Remove tags, Change status, Re-verify/enrich, Export CSV, Archive — each behind a confirm dialog, each
  reporting the **server-returned affected count** via a toast. On the list detail we mount the **same bar**;
  it appears (sticky) when `bulk.count > 0`, identical to `ProspectPage`'s `{bulk.count > 0 && <BulkActionBar …/>}`.
- **Selection model on a list.** The list's "select all matching" resolves to **all members of this list**. The
  bar's selection currently builds `{ contactIds }` (explicit) or `{ criteria }` (a search `ContactQuery`). For
  lists we add a third resolution: **`{ listId }`** (all members), so a bulk op can target the whole list
  server-side without enumerating ids — capped server-side exactly like select-all-matching. This is a small,
  additive change to the selection→payload mapping (`useBulkSelection.toBulkSelection` / the bulk APIs accept
  `{ listId }` per `09 §Phase 3`: "Accept `{ listId }` or `{ contactIds }` selection"). Explicit-id mode is
  unchanged.
- **Add-to-list note:** the existing `ListPickerDialog` disables select-all-matching for add-to-list (the lists
  endpoint takes explicit `{ contactIds }`); the **`{ listId }`-source** path (this whole list → another list,
  e.g. duplicate-into) is a separate server capability, not the add-to-list dialog — keep that distinction.
- **Remove-from-list** — the **one genuinely list-specific operation** (it has no prospect analogue). It is:
  - a **per-row** action: extend the reused `RowActions` with an `onRemoveFromList` callback (the menu already
    renders each item only when its callback is supplied, so passing it adds a "Remove from list" item with no
    risk to the prospect callers — and it is **danger-toned**).
  - a **bulk** action: add a "Remove from list" item to the bar's `moreItems` **only when the bar is rendered on
    a list** (gate it by an optional `listId`/`onRemoveFromList` prop on `BulkActionBar`; absent on Prospect, so
    Prospect is untouched). Opens a `RemoveFromListDialog` (confirm: "Remove N from '<list>'? This removes the
    membership; the contacts themselves stay in your workspace.") and posts `DELETE /lists/:id/members`.
  - Remove-from-list **deletes the `list_members` row, not the contact** — copy must make that unambiguous
    (deletion of the contact is DSAR territory, `02`/`09 §Phase 5`).

### 3.4 Member quick-view drawer

`MemberQuickView` is a **lightweight** read-only drawer for a member — model it directly on
`QuickViewDrawer.tsx`: the foundation `Drawer`, `Avatar` + name + title, a `StatusBadge` of data-health
(`dataHealthTone`), and a few **masked** facets (company/domain, seniority, department, location, masked email,
**phone "Locked — reveal"**). It has an **"Open full record"** button that hands off to the heavy `RecordDetail`
(reused) for reveal/edit/timeline. The drawer adds **two list-context affordances** the prospect quick-view
doesn't need: a small **"Member since / added via"** line (from `list_members.added_via` per `02`) and a
**"Remove from list"** danger action. Otherwise it is the same component shape; if the deltas are small we
**reuse `QuickViewDrawer` directly with optional list-context props** rather than forking it.

---

## 4. Reuse map — compose, do not rebuild

The governing constraint (`09 §Phase 1`, this doc's premise): **do not rebuild the table or the bulk bar.**
Explicit accounting of what is **reused** vs **new**:

### Reused unchanged (import and compose)
| Piece | From | Used for |
|---|---|---|
| `DataTable`, `Column` | `@leadwolf/ui` | The members table body. |
| `BulkActionBar` (+ all its dialogs, `BulkRevealDialog`) | `features/prospect` | The entire bulk surface (reveal/enrich/tags/status/owner/export/archive/enroll). Add an optional `listId`/`onRemoveFromList` prop; **no behavioral change for Prospect**. |
| `useBulkSelection` (`ProspectBulkSelection`) | `features/prospect/hooks` | Multi-row selection + select-all model (extended to resolve `{ listId }`). |
| `RowActions` | `features/prospect` | Per-row overflow menu (add `onRemoveFromList`; existing render-if-callback pattern makes this safe). |
| `ProspectToolbar` | `features/prospect` | Sort `TpSelect` + column-chooser `DropdownMenu`. |
| `QuickViewDrawer` (or its shape) | `features/prospect` | The member quick-view (with optional list-context props). |
| `RecordDetail` | `features/prospect` | The heavy reveal/edit/timeline panel — handed to from the quick-view, unchanged. |
| Masking/view helpers: `emailGlyphFor`, `maskedEmail`, `displayName`, `dataHealthTone`, `EMAIL_STATUS_LABELS`, `SENIORITY_LABELS`, `OUTREACH_STATUS_OPTIONS` | `features/prospect/types.ts` | Identical masking + glyphs + status labels (PII-safe by construction). |
| State Kit: `StateSwitch`, `EmptyState`, `LoadingState`, `ErrorState`, `Skeleton` | `@leadwolf/ui` | The four states on index + detail. |
| `PageHeader` | `apps/web/src/components` | Both surface headers (the shared `(shell)` header). |
| `Dialog`, `Drawer`, `DropdownMenu`, `Tooltip`, `SegmentedControl`, `StatusBadge`, `Avatar`, `TpButton`, `TpInput`, `TpSelect`, `TpCheckbox`, `FieldGroup`, `useToast` | `@leadwolf/ui` | All controls/overlays/feedback. **No new primitives.** |
| `currentUserId`, `fetchLists`, `createList` | `features/prospect/bulkResourcesApi` | "You"/owner check; the list option list; create-from-bulk — reuse rather than re-implement. |

> **Refactor to enable reuse (small, mechanical):** lift the `Column<ContactHit>[]` array out of `ProspectPage`
> into an exported `prospectColumns({ bulk, density, onRowAction })` factory in the prospect slice, so both the
> Prospect grid and the Lists members table build columns from one definition. This is the single structural
> change reuse requires; it does not alter the prospect surface's behavior.

### New (this slice only)
| Piece | Why it's new |
|---|---|
| `ListsIndexPage`, `ListCard`, `CreateListDialog`, `ListSettingsMenu` | The index surface has no prospect analogue (a "list of lists"). |
| `ListDetailPage`, `ListHeader` | The list-level header/metadata/provenance has no analogue. |
| `ListMembersTable` (thin wrapper) | Composes the reused columns/table; ~tens of lines, not a new table. |
| `RemoveFromListDialog` + the remove-from-list row/bulk wiring | The **only** truly list-specific mutation. |
| `useLists`, `useList`, `useListMutations` | Mirror `useContacts`/`useBulkSelection`; data + optimistic CRUD for lists. |
| `listsApi.ts` | Typed `fetchWithAuth` client for the lists routes (mirrors `prospect/api.ts`; reuses `ApiError`/`toApiError`/`notBuilt` patterns). |
| `lists/types.ts`, `lists.module.css`, `lists/index.ts` | Slice-local view-model + styling + barrel. |

**Net:** the only genuinely new *interaction* is **remove-from-list**; everything else is the prospect machinery
composed around a list-scoped data source.

---

## 5. Design system

Governed by `truepoint-design`. **Light theme only — no dark mode** (the app is light-only; do not add a dark
variant or `prefers-color-scheme` branch).

- **Tokens only.** All color/spacing/radius/motion via `var(--tp-*)` (e.g. `--tp-ink`, `--tp-ink-3`,
  `--tp-ink-4`, `--tp-surface-3`, `--tp-space-*`, `--tp-radius-*`, `--tp-ease`). **No raw hex, no ad-hoc px
  colors.** Styling lives in `lists.module.css` + inline token styles (mirroring the prospect/`ProspectToolbar`
  pattern of `style={{ color: "var(--tp-ink-3)" }}`).
- **Masked PII by default (the security/data line, D-masking + `06`/`05`).** The list is a masked surface exactly
  like Prospect: **email shows domain only** (`maskedEmail` → `•••@domain`), **phone is locked** (🔒 "Phone
  hidden until reveal"), full PII appears **only** after a server-gated reveal (`RecordDetail`/`BulkRevealDialog`,
  mechanics in `06`). Masking is **server-side** (the masked DTO carries no PII); the UI never un-masks locally
  and never fabricates an address (the `RowActions` "Email — reveal first" inert hint is the model). **Export
  emits masked, non-PII columns only.** This is non-negotiable per the read-first rule — a list is prospect PII;
  security/data own the boundary, design defers to it.
- **Status glyphs, not row color.** Hierarchy reads in the **glyph**, never in row background: ✓ valid / ?
  risky-unknown / — none (the `emailGlyphFor` mapping), so the table stays monochrome and scannable. The
  `list_kind` and data-health states use `StatusBadge` tones, not colored rows.
- **Quiet empty states** — one muted glyph max, a title, ≤1 line of guidance, a single action (the `EmptyState`
  contract). No illustrations, no marketing.
- **WCAG 2.2 AA.** Every control is reused from `@leadwolf/ui`, which already carries the a11y affordances:
  checkboxes have `aria-label`s ("Select all shown", "Select <name>"), icon-only buttons use `TpIconButton`'s
  `label`, the bulk bar is an `aria-label`'d region, loading uses `role="status"`/`aria-busy`, errors use
  `role="alert"`. New list-specific controls follow suit: name inputs labelled via `FieldGroup`, the remove/
  delete danger actions keyboard-reachable and confirm-gated, focus moved into dialogs/drawers and restored on
  close (foundation `Dialog`/`Drawer` behavior). Color is **never** the sole signal (glyph + label + tone).
  Respect `prefers-reduced-motion` (the shared skeleton/`--tp-ease` are reduced-motion-safe).
- **Density** — the same Comfortable/Compact `SegmentedControl`, `data-density` on the page wrapper, so large
  member lists can compact (and large lists stay keyset-paginated, §3.1).

---

## 6. Sharing / collaboration (D4 — owner is a filter, not a wall)

Lists are **workspace-shared by default**: every member of the workspace can **see and work** a list, because
the hard isolation boundary is **Postgres RLS at the workspace/tenant level** (D4: "List ownership and 'my
lists' are **filters**, not a new access wall"; mirrors the prospect soft-owner model). The UI reflects this:

- **"My lists" is a filter.** The index's `All · Mine` `SegmentedControl` (§2.1) filters the *displayed* set to
  `ownerId === currentUserId()` — a **view convenience**, applied as a query param (shareable URL), **not** an
  authorization decision. Switching to "All" shows every workspace list. There is **no** owner-based hiding of
  data; RLS already guarantees you only ever see your own workspace's lists, and that guarantee is below the app
  layer (D4) — the filter never weakens it and is never relied on for safety.
- **Owner-gated mutations (a UX gate over a server-enforced rule).** Rename, delete/archive, and editing list
  metadata (notes/tags) are surfaced **only to the owner** (and, where the role model allows, workspace admins —
  per `07`/`truepoint-security`). The UI hides/disables those affordances when `ownerId !== currentUserId()` and
  the actor isn't an admin — **but the enforcement is server-side** (the API authorizes the mutation against the
  caller's membership/role; the client gate is convenience, not a boundary — same principle as `auth` flow
  validation being the real boundary, GUC being app-set). A non-owner can still **work** the list (add members,
  run bulk actions on members they're permitted to act on) — only the **list-object lifecycle** (rename/delete)
  is owner-gated.
- **Owner display.** The card/header show the owner (`Avatar` + name, "You" for self) so a shared list's
  provenance is legible; "added via" on members (§3.4) shows how each member arrived.
- **No new sharing UI in this plan** (no per-list ACLs, invites, or link-sharing) — workspace-shared + owner-gated
  lifecycle is the whole model (D4). Cross-workspace sharing is explicitly out of scope; RLS forbids it.

> **Precedence note:** anything touching *who can see/do what* defers to `truepoint-security` and `02`/`08`. This
> doc renders the affordances; it does not invent an access model. The client owner-gate is UX; the wall is RLS.

---

## 7. i18n / copy + loading / optimistic patterns

Consistent with the prospect surface's conventions:

- **Copy / i18n.** All user-facing strings are **plain, calm, sentence-case** (the prospect tone: "No matches",
  "Phone hidden until reveal", "Revealed PII is never included in the export"). Strings are **centralized** in
  `lists/types.ts` label maps (mirroring `EMAIL_STATUS_LABELS`/`OUTREACH_STATUS_LABELS`) so they're translation-
  ready and never inlined ad-hoc. **Pluralize** counts the way the bulk bar does (`contact${n === 1 ? "" : "s"}`,
  `member${n === 1 ? "" : "s"}`) and format numbers with `toLocaleString()`. Copy must be **honest about
  masking, cost, and not-yet-built backends** (the existing `notBuilt` → "not available yet" toast pattern for
  enroll/handoff). Cost-bearing actions always state the spend before the user commits (D5).
- **Loading.** Index and detail wrap their bodies in `StateSwitch` (error → loading → empty → content). Lazily
  load picker option lists on first open (the bar already does this for lists/sequences). Keep large member
  lists **keyset-paginated** with "Load more" (never load-all).
- **Optimistic mutations** (`useListMutations`) — mirror the prospect grid's in-place patching (`markRevealed`
  patches one row instead of refetching):
  - **Create** — optimistically prepend the new list to the index; reconcile/rollback + error toast on failure.
  - **Rename** — optimistic name swap; revert on error.
  - **Archive/delete** — optimistic removal from the index with an **Undo** affordance window where feasible
    (archive is reversible by design); hard-delete reverts on failure.
  - **Remove-from-list** — optimistically drop the member row(s) from the table; on failure, re-insert + toast.
  - **Bulk mutations** — keep the bar's existing model: run server-side, **toast the server-returned affected
    count** (never a client-computed count), then `reload()` the members and `clear()` the selection (exactly
    `BulkActionBar.run`). Reveal flips rows in place (`markRevealed`-style) without a full refetch.
- **Toasts** — `useToast` for every mutation result (`success` with the affected count; `error` with the
  `ApiError.message`), matching the bulk bar.

---

## 8. Cross-references (sibling docs)

- `00-overview.md` — D1–D5, vocabulary, scope, the three core jobs, doc index. **Canonical; this doc obeys it.**
- `02-data-model.md` — list/list_members schema, `list_kind`, source/tags/notes/`added_via`/`archived_at`,
  RLS, audit, DSAR cascade. **This doc consumes those DTOs; it does not define them.**
- `03-upload-and-import.md` — the "Import into list" wizard (CSV/XLSX, map, dedup, preview, receipt). The index
  + detail only place the **entry CTA** and the receipt strip.
- `05-prospect-to-list.md` — reveal-from-Prospect → add-to-list, the stubbed `RecordDetail.addContactsToList`
  fix, bulk add-to-list, select-all-across-search. The detail header's **"Add from Prospect"** routes here.
- `06-enrichment-verification.md` — bulk enrich/verify/reveal mechanics: match-first → waterfall, **cost
  estimate-before-spend** (D5), credit-back on bounce. This doc renders the **trigger + confirm + toast** only.
- `07-admin-staff-governance.md` — staff see **metadata + aggregate only** (D2); record-level only via
  break-glass. This is the **customer** surface; staff governance is enforced elsewhere.
- `08-security-compliance.md` — RLS, encryption, residency, DSAR/retention — the boundary this UI defers to.
- `09-rollout-phases.md` — Phase 1 ships this surface behind `lists.tab`; work-units 6 (`web` nav + index), 7
  (`web` detail + members reuse + bulk wiring), 8 (`web` Prospect add-to-list fix) are this doc's build.
```
