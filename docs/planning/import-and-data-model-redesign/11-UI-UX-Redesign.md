# 11 — Import UI/UX Redesign

> **Status of this doc:** complete (design doc — target state 🔲 not built; nothing ships from
> this series). Evidence cites [`01-Current-State-Audit.md`](01-Current-State-Audit.md); gaps cite
> [`02-Root-Cause-and-Gap-Analysis.md`](02-Root-Cause-and-Gap-Analysis.md); every external-platform
> claim cites the register in [`03-Enterprise-Research.md`](03-Enterprise-Research.md).
> **Owns:** the **frontend half of G11** (poll abandonment — doc `09` owns the durable-progress
> backend), **G21** (no duplicate-review surface), the **toggle-kill half of G10** (doc `08` owns
> server-side routing), and the **presentation half of G14** (artifact/error UX — content contract
> in `08` §6, PII posture in `13`). Consumes as contracts, never re-specs: doc
> [`08`](08-Import-Architecture.md) (state machine, verbs, mapping subsystem, preview, strategies,
> artifacts), doc [`09`](09-Queue-and-Background-Processing.md) (progress/notification contracts,
> the §9 state→copy table — adopted verbatim below), doc
> [`10`](10-Visibility-and-Permissions.md) (verb×role matrix, own-vs-all scoping, attribution).
> **Step IDs:** `S-U1`…`S-U8` (sequenced in doc `15`; never fixed migration numbers).

---

## Objective

Make importing feel like a product, not a gamble. A dedicated Imports section (history + wizard)
replaces the single-card page; the wizard becomes a five-step guided flow that ends in a durable
job the user can walk away from; progress survives navigation and completion arrives as a
notification (the G11 fix — no more dead two-minute poll); the "Large file" dead-end toggle is
deleted (G10 — the server decides, the UI never asks); errors become artifacts and a repair loop
instead of a shrug; and duplicate markers finally get a review surface (G21). Every surface obeys
the design mandates: `@leadwolf/ui` only, `var(--tp-*)` tokens, `StateSwitch` four-states,
virtualized/paginated tables, detail-in-drawer, light theme, WCAG 2.2 AA.

---

## Reconciliation (what this design builds on and must never contradict)

Pinned to shipped code at the same head as doc 01 (branch `feat/data-mgmt-01-research-brief`):

- **Shipped UI ground truth (01 §2, §4, re-verified for this doc).** The import feature lives at
  `apps/web/src/features/import/` — `components/ImportWizard.tsx` (single-card source/mapping/
  validate/conflict flow; the dead-end toggle at `ImportWizard.tsx:305–313`; the 403 apology copy
  at `:427–432`), `components/ImportPage.tsx` (wizard + a non-virtualized workspace contacts
  table on one page), `hooks/useImport.ts` (1.5 s × 80 poll then give-up copy,
  `useImport.ts:30–31,79–83`),
  `components/BulkImportProgress.tsx` + `hooks/useBulkImport.ts` (the dark path's durable-poll page at
  `/imports/[jobId]` — 3 s cadence, terminal-stop, distinct `disabled` state: **the pattern this
  doc generalizes**, not new invention). The `/import` route sits **outside** the `(shell)` route
  group (`apps/web/src/app/import/page.tsx`) while `(shell)/imports/[jobId]` is inside it — the
  IA below heals that split. `RecentImportsCard.tsx` renders workspace-wide batches (01 §4.4).
- **Navigation is single-sourced.** `apps/web/src/components/shell/navConfig.ts` is "the SINGLE
  source of truth for app navigation" — rail `DESTINATIONS` (7 today), `SETTINGS_NAV`,
  `sectionTitleFor`, and the command-palette entries (including the `act-bulk-import` palette
  entry that deep-links the dead-end toggle flow). All IA changes land there, once.
- **Shipped duplicates surface (reconciled — narrows G21's "no UI" framing).** Data Health
  already ships a dismiss-only duplicates tab:
  `apps/web/src/features/data-health/components/DuplicatesSection.tsx` (a `DataTable` of
  auto-flagged pairs, per-row "Not a duplicate") over
  `hooks/useDuplicatePairs.ts` (`GET /contacts/duplicates`, full-list load, no pagination, no
  filters). G21 stands for everything else — no merge, no `match_links`/ER inflow, no import
  linkage, no company queue, no keyset — and §5 **generalizes that section in place** (same
  Data Health home, the dismiss verb survives) rather than green-fielding beside it.
- **Design-system reality (`packages/ui/src/index.ts`).** Available and used by name in §8:
  `StateSwitch`/`LoadingState`/`EmptyState`/`ErrorState`/`Skeleton`, `DataTable`+`Pagination`,
  `Drawer`/`Dialog`, `Tabs`/`SegmentedControl`, `Card`, `Progress`, `StatusBadge`, `StatTile`,
  `Combobox`, `DropdownMenu`/`Popover`/`Tooltip`, `ToastProvider`/`useToast`, `Avatar`,
  `FormSection`/`FieldGroup`/`FormRow`, `Badge`/`Alert`/`RadioGroup`/`RadioOption`, and the Tp\*
  controls. **`DataTable` is explicitly not virtualized yet** (its own header:
  "Not virtualized yet … a TanStack swap is a follow-up") — a named DS gap this doc plans
  around (§2, §8.3), not a license to hand-roll a table.
- **TanStack mandate vs shipped reality (tension, resolved).** The architecture skill mandates
  TanStack Query for server state; shipped `apps/web` hooks are `useState`+`useEffect` pollers
  with explicit "NO TanStack" comments (`useBulkImport.ts` header) and **no `@tanstack/*`
  dependency installed**. Per the skills' own convention ("the mandate is the target and the gap
  is work to do"), this redesign is the adoption point: S-U1 adds the dependency and all new
  hooks ship TanStack-shaped (§8.2). Existing hooks are migrated only as their surfaces are
  rebuilt — no big-bang rewrite.
- **Sibling contracts consumed verbatim:** 08 §2 state machine + §2.3 verb table (the UI renders
  exactly those verbs and problem slugs), 08 §3 mapping subsystem (binary auto-map, ordinal
  addressing, template visibility), 08 §6 artifacts + retry-child, 09 §4.3 poll-never-dies
  cadence (2–3 s active / 10 s queued/deferred / stop on terminal), 09 §9.2 state→copy table
  (finalized in §4.2 below), 10 §2.1 verb×role matrix (every button's disabled/hidden logic),
  10 §5 row 9 (Recent Imports card split). The duplicate-review *semantics* are 04 §3
  (survivor/loser contract, pinned-field immunity per DM6, 2-record cap, no bulk merge) and
  06 §5 (C3 + ambiguity fail-loudly-to-review); this doc renders them.
- **Feature flags:** every behavioral change rides 08/10's dual gates (`IMPORT_V2_ENABLED` +
  per-tenant `import_v2_enabled`; `JOB_VISIBILITY_SCOPED` + `job_visibility_scoped`). Flag-off =
  byte-identical current UI. One deliberate exception: **the toggle kill (S-U1) is
  flag-independent** — 08 §1.2 records that it "can die in Phase A"; today the toggle only
  manufactures 403s (bulk is dark in every environment, 01 §4.1), so deleting it removes a
  guaranteed failure and changes nothing else.
- **Prior decisions untouched:** DM4 (no tenancy change), DM6 (pins block overwrite — rendered,
  never re-implemented client-side), ADR-0028 (custom fields = typed registry + jsonb; the
  in-flow creation UI calls the existing registry), the two-surface rule (nothing here gates on
  staff capabilities), and the architecture skill's UI-consolidation rule (§1 applies it to
  decide what does NOT become a new page).

---

## Current Challenges (headline only — the as-is is doc 01)

- One page does everything: wizard + contacts table at `/import`, outside the shell group; no
  imports list exists anywhere; the palette advertises "Bulk import (large file)" into a 403.
- The wizard recommends a path that always fails (01 §4.1, G10), the poll dies at ~2 minutes
  with nowhere to check back (01 §4.2, G11), and navigating away destroys the only job handle.
- Completion reporting is a transient inline summary; rejected rows download from client memory
  and are gone on refresh; no repair loop, no retry (G14 presentation half).
- Duplicate handling stops at dismiss: the shipped Data Health duplicates section lists
  auto-flagged pairs with only "Not a duplicate" — no merge, no I5 `match_links` inflow, no
  import linkage, no filters/pagination (G21); ambiguous company matches have nowhere to land
  (06 §5).
- Every member sees every member's imports on the home card (01 §4.4 — fix is 10's; the card
  copy/toggle is this doc's).

## Enterprise Best Practices (cited via 03's register only)

- **Import history is a first-class navigable surface** with per-job completion accounting on
  every platform that does this well (03 §1.1 [4][86][79], §5.1 [6][54]); the completion summary
  is created/updated counts + an error-type table + row drilldown (03 §1.1 [5][30]).
- **One wizard, server decides** — HubSpot's single flow with limits-as-quotas vs Salesforce's
  legacy two-tool fork (03 §1.3 [1][3][30]); the five-step backbone: entity → mode/dedup (an
  **explicit early step** — implicit dedup causes duplicate disasters, 03 §1.3 [86]) → upload →
  map → review/preview → run (03 §1.2 matrix).
- **Auto-map is binary** (mapped/unmapped + per-column override + explicit "don't import");
  no vendor shows confidence percentages (03 §1.1 [1][2][85], §1.3). In-flow typed custom-field
  creation is table stakes (03 §1.1 [1][85]). **Named workspace-shared mapping templates are
  shipped by nobody** — the leapfrog (03 §1.1 [21][4][32]).
- **Async-with-notification is the market model** — submit, leave, get told (03 §1.1 [30],
  §6.1 [18]); progress = durable counters polled indefinitely, never a give-up (03 §6.3
  [56][129]).
- **Duplicate review is a persistent queue object**, not a save-time popup (03 §2.1 [34][8][88]);
  merge UX is side-by-side with per-field pick and is irreversible everywhere — guardrails, not
  unmerge (03 §2.1 [9][70][40][87]).
- **Both error artifacts** (repair CSV + error report) with typed codes, impact counts, and
  `_REDACTED_` values (03 §1.1 [5], §6.1 [58][18]); artifact downloads are gated and audited
  (03 §5.1 [6][7]).

## Gaps (register pointers — evidence in 01, linkage in 02)

| Gap | Sev | This doc's answer |
|---|---|---|
| **G11** (frontend half) | P1 | §3.5/§4: commit → durable job page, immediately navigable away; poll never dies (09 §4.3 cadence); completion notification; the give-up copy is deleted from the codebase |
| **G21** | P2 | §5: persistent duplicate-review queue under Data Health + ambiguous-company tab; side-by-side per-field merge review per 04 §3 |
| **G10** (UX half) | P1 | §1.4: the toggle, its palette entry, its copy, and its error states are deleted (flag-independent slice); server routing is 08 §1 |
| **G14** (presentation half) | P1 | §6: taxonomy-grouped errors, row drill-in, two artifacts with PII warning + "downloads are logged" notice, retry-failed flow |
| G04 (page half) | P0 | §2: the history page over 08 §7's endpoints |
| G01/G02 | P0/P1 | consumed from 10: own-vs-all rendering, attribution, disabled-with-reason create states |
| G05 | P1 | §2.3/§4: cancel with stop-remainder copy ("rows already imported were kept") |

---

## Recommended Solution

### §1 Information architecture 🔲

#### §1.1 Routes and nav placement (the decision)

**Imports becomes a primary rail destination.** `navConfig.ts` `DESTINATIONS` gains
`{ label: "Imports", href: "/imports", match: "/imports", icon: Upload }`, placed after
**Lists** (data-collections next to data-in). Rationale against the alternatives: burying
imports in Settings (the HubSpot placement) contradicts this product's positioning — imports are
the primary data-acquisition verb for a sales-intelligence workspace, and the two reported
problems are both discoverability failures; a Home-card-only entry repeats today's
nowhere-to-check-back defect. The consolidation rule is honored by what does **not** get a rail
item: duplicate review (§1.3) and the wizard (a sub-route, not a destination).

| Route (all inside `(shell)`) | Surface | Replaces |
|---|---|---|
| `/imports` | History dashboard (§2) — the section landing | nothing (G04) |
| `/imports/new` (`?entity=contacts\|companies&listId=…`) | The wizard (§3), full-page five-step flow | `/import` (route retired; redirect kept one release) |
| `/imports/[jobId]` | Durable progress + completion (§4) | shipped `BulkImportProgress` page, generalized to all imports |
| `/data-health/duplicates` | Duplicate review queue (§5) | nothing (G21) |

`sectionTitleFor` collapses its two special cases (`/imports/` → "Bulk import", `/import` →
"Import") into the Imports destination match. The orphan `/import` route and `ImportPage.tsx`'s
wizard-plus-contacts-table composition retire — the contacts table already has real homes
(Prospect, Lists); an import page that doubles as a contacts browser is the consolidation
anti-pattern in the other direction.

#### §1.2 Entry points (deep links with presets)

- **Prospect — people view:** "Import contacts" → `/imports/new?entity=contacts`.
- **Prospect — companies view:** "Import companies" → `/imports/new?entity=companies`.
- **Lists — list detail:** "Import into this list" → `/imports/new?entity=contacts&listId=<id>`
  (the shipped `targetListId` contract; the server still validates the id against the workspace,
  `routes.ts:149–150` — the preset is convenience, never trust).
- **Home Recent Imports card:** "View all imports" footer link → `/imports`.
- **Command palette:** `act-import` → `/imports/new`; new `act-imports-history` → `/imports`;
  **`act-bulk-import` is deleted** (§1.4).
- **Empty states:** the history page's first-run empty state and the contacts-empty states
  deep-link `/imports/new`.

Presets prefill wizard state and render as a dismissible context chip ("Importing into
'Q3 Prospects'" · `TpChip` with remove); the wizard is identical with or without them.

#### §1.3 Duplicate review lives under Data Health (consolidation call)

The review queue's inflow is broader than imports (the automated sweep, I5 `match_links`, C3
company reviews — 04 §3.5), and Data Health is the shipped rail destination for data-quality
work — it already carries the dismiss-only duplicates section this queue upgrades
(Reconciliation). Decision: the queue is a **Data Health tab** at `/data-health/duplicates`
(§5), entered
from (a) the Data Health page, (b) every import completion summary's "N potential duplicates
flagged" rollup (08 §5.3), and (c) the job-detail drawer. No new rail item; "standalone nav" is
satisfied by the existing destination.

#### §1.4 Kill the "Large file" toggle (G10, flag-independent) 🔲

Deleted in S-U1, per the removal-cleanup rule (every trace): the `TpCheckbox` and `largeFile`
state (`ImportWizard.tsx:305–313`), the `onSubmitBulk` fork and its `bulkBusy/bulkErr/
bulkDisabled` states, the "Switch off 'Large file'" apology copy (`:427–432`), the
`act-bulk-import` palette entry, and the "Confirm & import in background" button variant. The
UI never asks how a file should be processed again — mode is the server's commit-time decision
(08 §1), invisible except as the honest `file_too_large`/`xlsx_too_large` refusals rendered at
upload (§3.1). `BulkImportDisabledError` handling survives only on the legacy progress page
until Phase C retires the legacy surface (08 §1.2).

#### §1.5 Recent Imports card — own-jobs-by-default (aligns 10 §5 row 9)

- **Members:** card title becomes **"Your recent imports"**; renders only the viewer's batches
  (the predicate is server-side — 10's `recentBatches(scope, viewer)`; the card never filters
  client-side). No toggle.
- **Elevated (admin/owner):** title "Recent imports"; a compact `SegmentedControl`
  (**Mine · Workspace**, default **Workspace** — matching the history page default §2.2) and a
  creator line (`Avatar` + display name) per row.
- Both variants gain the "View all imports" footer link. Empty-state copy for members changes to
  "You haven't imported anything yet" + a "Start an import" action. Gated by the
  `JOB_VISIBILITY_SCOPED` dual gate with 10's comms plan (flag-off = today's card).

### §2 The import history page — `/imports` 🔲

#### §2.1 Layout

`PageHeader` ("Imports", primary `TpButton` "New import" → `/imports/new`) · a filter row
(`TpSelect` status, `TpSelect` source, date range, and the §2.2 scope control) · the jobs table ·
`Pagination` (keyset — cursor from 08 §7's list endpoint; page size 50). Drafts are excluded
(08 §7); a slim "Resume draft" `Alert` appears above the table when the viewer has live drafts
(opt-in `state=draft` query).

#### §2.2 Table contract

Columns (all data from 08 §7's list shape; no client aggregation):

| Column | Renders |
|---|---|
| File | `source_filename` (08 S-I1) + entity icon; falls back to source label for legacy rows |
| Entity | Contacts / Companies `Badge` |
| Status | `StatusBadge` with the §4.2 copy + tone (completed=success, partial/paused=warning, failed=danger, all non-terminal + cancelled=muted — the §4.2 tone note) |
| Progress | `Progress` (derived `percent` from 09 §4.1) while non-terminal; "—" when terminal |
| Rows | `rows_total` + landed count (created+matched) |
| Created by | `Avatar` + display name (10 attribution; "System" rows elevated-only; "Former member" fallback) — column rendered only in the all-jobs view |
| Started / Finished | relative timestamps (`Tooltip` = absolute) |
| ⋯ | `DropdownMenu` row actions: View · Cancel · Retry failed rows · Download artifacts · Use as template — each item present/disabled strictly per 10 §2.1 |

**Scope:** members get their own jobs, no control (the server enforces it — 10 §2.1); elevated
roles get a `SegmentedControl` **Mine · Workspace** defaulting to **Workspace** (they came to
supervise; HubSpot's shared-list-with-attribution shape, 03 §5.1 [6][7]).

**Rendering discipline:** `DataTable` + keyset `Pagination`, sticky header, row click opens the
drawer (never navigates — detail-in-drawer mandate). Server pagination bounds the DOM today;
the DS virtualization upgrade (§8.3 gap) lifts the ceiling later without changing this page's
contract. Live rows refresh via one list-level TanStack poll (10 s while any visible row is
non-terminal, else off) — one request, never per-row pollers.

#### §2.3 Detail drawer

Row click → `Drawer` (right, ~560 px; focus-trapped; URL sync via `?job=<id>` so it is
shareable/restorable):

- **Header:** filename, `StatusBadge`, creator, "Open full page" (→ `/imports/[jobId]`).
- **Status timeline:** vertical list of reached states with timestamps (derived from the job
  row's stage timestamps; §8.3 flags the `Timeline` primitive as a DS gap — interim rendering is
  a token-styled list, not a raw hand-rolled component tree).
- **Live counters:** the seven-bucket `StatTile` grid (§4.3's labels), polling per 09 §4.3 while
  non-terminal.
- **Error summary:** top reject codes with impact counts (the histogram + warning band) linking
  to §6's grouped view on the full page.
- **Artifacts:** repair CSV + error report download rows (§6.2) — rendered only for callers
  passing 10's artifact gate; others see an honest "Only the importer or an admin can download
  error files" line, not a hidden section.
- **Actions:** Cancel (with the §4.2 confirm dialog), Retry failed rows (§6.3), Use as template
  (prefills `/imports/new` from this job's stored mapping/strategy — the repeat-a-past-import
  mechanic, 03 §1.1 [4]).
- **Links:** parent/child retry chain (08 §6.3), "N potential duplicates flagged" →
  `/data-health/duplicates?importId=<id>`.

### §3 The wizard — `/imports/new`, five steps 🔲

Full-page flow inside the shell; a top step indicator (W1 Upload → W2 Map → W3 Preview →
W4 Duplicates → W5 Review — §8.3 flags `Stepper` as a DS gap); one step visible at a time
(progressive disclosure); Back never loses state. The wizard is a client for 08's draft flow
(`POST /imports` → draft · `PUT mapping` · `POST preview` · `POST commit`); until Phase B
(G07) the legacy one-shot submit backs the same five screens — identical UI, the commit call
simply carries mapping+strategy in one request (08 §2.3 legacy dispatch). Leaving mid-flow
prompts once ("Your draft is saved for 48 hours" post-Phase-B; "Your setup will be lost"
pre-Phase-B — honest per phase). `?step=` in the URL enables resume/back-button sanity.

#### W1 — Upload

- **Entity choice:** `RadioGroup` — **Contacts** (default; company columns ride along on
  contact rows and upsert accounts — that *is* the mixed case, 06 §5) · **Companies**
  (companies-only file, 06's ladder). Stated decision: no third "mixed" option — it would
  duplicate the contacts flow under a scarier name.
- **File intake:** drag-drop zone + file picker (`FileDropzone` — DS gap §8.3; falls back to the
  styled `TpInput type="file"` until it lands). Accepts `.csv`/`.xlsx` with the published limits
  (doc 12) shown *before* selection ("CSV up to N rows / M MB · XLSX up to the fast-path
  ceiling").
- **Client-side pre-validation (UX only — the server re-checks everything):** extension + MIME
  sniff mismatch warning; size vs published ceiling (**blocks** with the same copy the server's
  413 would use — no upload of a guaranteed rejection); encoding sniff (BOM/UTF-16 detected →
  informational `Alert`; suspected mojibake → warning with "we'll flag affected rows");
  header-row presence (first-line read, the shipped `readHeaders` mechanic).
- **Template download:** "Download a template" link per entity — canonical headers including
  multi-channel slot columns (`Mobile phone`, `Direct dial`, `HQ phone`, `Secondary email`, …)
  so the file teaches the mapping (05 §6 vocabulary).
- Context chip when `listId`/`entity` presets are active (§1.2).

#### W2 — Mapping

The heart of the wizard; renders 08 §3's contract:

- **Layout:** a two-pane mapping table (03 §1.1 [85][92]) — left: source column (header text +
  3 sample values, ordinal-addressed so duplicate headers are distinct); right: target control.
  One row per source column, every row keyboard-reachable (§7.1).
- **Auto-map result:** each row shows a **binary state chip** — `mapped` (target name) or
  `unmapped` — never a confidence percentage (03 §1.3). The target control is a `Combobox`
  grouped by: Identity · Person · Company · Channel slots (05 §6: phone types mobile/direct/
  hq/…, email types work/personal) · Custom fields · **"Don't import this column"** (explicit,
  distinct from unmapped — unmapped required fields block commit, 08 §3.2).
- **Multi-value channels:** N phone/email columns map to N typed slots; a per-column type badge
  shows the slot; a soft warning appears past the channel cap (05 pre-build:
  `channel_cap_exceeded` is a warning band, rows still land).
- **Saved templates (the leapfrog):** a template bar — `Combobox` "Apply template" (workspace +
  private, 08 S-I2 visibility; private rows marked with a lock icon) · "Save as template…" →
  `Dialog` (name, visibility Private/Workspace radio, saves mapping **+ the W4 strategy block**,
  08 §3.1). Applying a template onto mismatched headers reports "n of m columns matched" and
  leaves the rest unmapped — never silently wrong.
- **In-flow custom-field creation (ADR-0028):** "+ Create field" inside the Combobox footer →
  `Dialog`: label, key (slugged), type (`TpSelect`, the registry's 6 types, prefilled by
  inference), then the column maps to `cf:<key>`. Gated by the registry's existing role gate;
  ungated users see the option disabled with reason (four-states discipline, 10 §UI/UX pointer).
- **Blockers strip:** unmapped-required and duplicate-header conflicts listed above the
  Continue button with jump-to-row links.

#### W3 — Validation preview

Renders 08 §4's preview response; nothing is computed client-side:

- **Projection band:** `StatTile` row — Total · Valid · Would create · Would update ·
  Duplicate in file · Rejected · Warnings (the Attio effect-preview + HubSpot full-file
  validation posture, 03 §1.1 [85][1][5]).
- **Sample grid:** the first-50 validated rows in a `DataTable` — per-cell verdict styling
  (reject = danger tint + `Tooltip` with the typed code; warning = warning tint), row status
  column. Read-only in v1 (Folk-style in-place editing is a doc 14 future).
- **Per-column feedback:** collapsible list per problem column — parse-failure count, dominant
  reject code, sample line numbers (08 §4) with a "Fix mapping" link back to W2 (preview
  invalidates on any mapping change — the shipped `invalidatePreview` discipline, kept).
- Continue is allowed with rejects (partial success is designed-for); the button says
  "Continue — N rows will be skipped" when rejects exist. A 100%-rejected preview blocks with
  guidance instead.

#### W4 — Duplicate strategy (the explicit step)

Implicit dedup causes disasters (03 §1.3 [86]) — so this is a full step, not a dropdown in a
corner (today's `conflictPolicy` select):

- **"How we match":** a static explainer of the shipped ladder — email → LinkedIn → Sales Nav
  id (contacts; 04 §2), domain set (companies; 06 §5) — with the live match estimate from W3's
  projection: **"~N rows match contacts you already have."**
- **Mode:** `RadioGroup` for the 08 §5.1 triad — Create & update (default) · Create only ·
  Update only — each with one honest consequence line ("Update only: rows that match nothing
  are skipped and reported").
- **Protect existing data:** `TpSwitch` — "Don't overwrite fields that already have values"
  (`preserve_populated`), plus the permanent footnote: **"Pinned fields are never overwritten by
  imports, regardless of this setting"** (DM6 — rendered as fact, enforced server-side by
  `planFieldWrite`, 08 §5.2).
- Defaults preload from the workspace `import_policy` strategy defaults (10 §3); an admin-set
  default renders a "Workspace default" `Badge`. Channel values are exempt from the mode
  (append-with-dedup, never destructive — 05 §6) and the copy says so.

#### W5 — Review & run (commit)

- **Summary card:** file, entity, list target, mapped-column count (+ "n skipped columns"),
  strategy sentence ("Create & update, matching on email → LinkedIn → Sales Nav; existing
  values protected"), projection recap, "Save these settings as a template" checkbox (08 §3.1).
- **Run import** (`TpButton` primary; disabled after first fire; Idempotency-Key on the commit —
  08 §2.3) → on 202: `router.push(/imports/<jobId>)` + toast "Import started — we'll notify you
  when it's done." **The user is free immediately** (G11): the job page is a URL, not in-memory
  state; the completion notification (09 §6.3) closes the loop; the wizard holds no poll loop at
  all — `useImport.ts`'s give-up copy is deleted with it.
- A `deferred` response renders the same success path with the §4.2 deferred copy — visible
  backpressure, not an error (09 §1.3).

### §4 Progress & completion — `/imports/[jobId]` 🔲

#### §4.1 The durable progress page

Generalizes the shipped `BulkImportProgress` to every import: `PageHeader` (filename + status) ·
`StatusBadge` + stage line ("chunk i of n" while running — 09 §4.1's derived `stage`) ·
`Progress` bar (percent; client-side interpolation between polls for smoothness — display only,
never invented state, 09 §4.2) · the seven-bucket counter grid (§4.3) · error summary + artifact
rows once terminal (§6) · Cancel while cancellable (10 matrix) · "N potential duplicates
flagged" link. Poll cadence is 09 §4.3's, **with no attempt cap** — the page answers for the
row's lifetime; refresh/navigation/return all resume cleanly because the handle is the URL.

#### §4.2 State → copy (09 §9.2 adopted verbatim; final strings pinned here)

| State | Final UI copy | Tone |
|---|---|---|
| `draft` | Draft — finish setting up your import | muted |
| `uploading` | Uploading your file *(Phase-B presigned flow only — direct uploads never surface it, 08 §2.1 / 09 §9.2)* | muted |
| `queued` | Waiting to start | muted |
| `deferred` | Queued — will start when a slot frees ({N} running) | muted |
| `validating` / `staged` | Preparing your file | muted |
| `running` | Importing — {X} of {Y} rows | muted |
| `paused` | Paused by TruePoint support | warning |
| `completed` | Done | success |
| `partial` | Done — {N} rows need attention | warning |
| `failed` | Failed — {reason} | danger |
| `cancelled` | Cancelled — rows already imported were kept | muted |

**Tone note:** tones are the shipped `StatusTone` set — `success | warning | danger | muted`
(`StatusBadge.tsx:5`); the monochrome system has no `info`/`neutral` tone, and non-terminal
activity is communicated by the `Progress` bar + stage line, never badge color. An optional
`info` tone is recorded as a DS-extension candidate in §8.3 — the copy table does not assume it.

Cancel confirm `Dialog` carries the stop-remainder contract verbatim: "Stops the remaining rows.
Contacts already imported are kept — cancelling doesn't undo them." (08 §2.2; cancellation ≠
undo, 03 §6.1 [61]). All strings live in the i18n catalog (design skill), interpolations typed.

#### §4.3 The completion summary bar

On any terminal state, a summary bar pins to the top of the job page (and compact in the
drawer): **Created {a} · Updated {b} · Skipped {c} · Needs attention {d}** with an expandable
error-type breakdown (top codes + impact counts) and "View all errors" drilldown (§6.1). Label
mapping is fixed so the seven-bucket identity (08 §1.1) stays honest: Created = `created`;
Updated = `matched`; Skipped = `skipped + deduped` (`Tooltip` explains the split); Needs
attention = `rejected + unprocessed` (split shown in the breakdown — failed vs never-attempted,
03 §6.1 [60]); Duplicates flagged = `duplicate`, rendered as the review-queue link, not a
failure. The in-app notification (09 §6.3) deep-links here; the notification preference row
("Import finished" — in-app default on, email opt-in) lands in the existing
Settings → Notifications page, not a new surface.

### §5 Duplicate review — `/data-health/duplicates` (G21) 🔲

#### §5.1 The queue

Two `Tabs`: **Possible duplicates** · **Company matches to review**.

**Possible duplicates** — a persistent queue over `duplicate_of_contact_id` markers + I5
`match_links` proposals (04 §3.5; the persistent-queue market pattern, 03 §2.1 [34][8]).
This upgrades the shipped dismiss-only `DuplicatesSection` in place (Reconciliation) — the
unmark verb survives as **Not a duplicate**; the queue semantics, filters, keyset, merge, and
`match_links` inflow are the new surface:
`DataTable` (keyset), one row per pair: the two contacts (names + primary email domain — masked
values stay masked), match reason chip (email / LinkedIn / name+domain / ER-proposed), "same
corporate family" chip when `root_account_id` matches (06 §2 — usually a subsidiary, not a
dupe), source (import file link when import-origin; `?importId=` filters the queue), age.
Row actions: **Review** (opens §5.2) · **Not a duplicate** (dismisses the marker; audited).
**Bulk action: dismiss only** — multi-select bulk "Not a duplicate" exists; **bulk merge is
deliberately not offered**: merge is irreversible and human-only side-by-side with a 2-record
cap and a daily cap per 04 §3.6's guardrails (the HubSpot bulk-merge heuristics, 03 §2.1 [88],
are recorded as a doc 14 future *after* merge earns trust). Filters: reason, family, source,
age. Empty state celebrates ("No duplicates waiting for review").

**Company matches to review** — the `ambiguous_company_match` queue (06 §5 C3 + ambiguity rows;
08 §5.3): one row per unresolved import row — the incoming company columns vs the ≥2 candidate
accounts (or the C3 fuzzy candidate). Actions: pick a candidate · "Create new account" ·
dismiss. Resolution re-drives just that row's account link (06's contract); everything audited.

#### §5.2 The merge review panel (side-by-side, per-field)

Review opens a full-height `Drawer` (or `Dialog` at ≥1280 px) rendering 04 §3's contract —
this panel *renders* decisions the server enforces; nothing merges client-side:

- **Survivor selection:** the two records side by side; survivor preselected by the 04 §3
  creation-order heuristic; a swap control. "The kept contact keeps its ID and history."
- **Field comparison grid:** one row per differing scalar — survivor value · loser value ·
  a per-field pick (radio pair). Defaults: survivor's populated value wins, loser fills blanks
  (03 §2.1 [9]). **Pin indicators (DM6):** a pinned survivor field renders a pin icon and a
  **locked** pick — the UI mirrors what `planFieldWrite` will enforce anyway (04 §3: pinned
  fields structurally unoverwritable), with a tooltip "Pinned — imports and merges never
  overwrite this."
- **Channels note (not a picker):** "All emails and phones from both records are kept; the
  duplicate's become secondary" (04 §3: loser channel rows re-point as secondaries; the
  survivor's primary is untouched) — shown as fact, no per-channel picking in v1.
- **Consequences strip:** re-point counts (activities, list memberships, reveals — Class A,
  04 §3) and the tombstone sentence: "The duplicate is archived and can't be unmerged"
  (irreversibility posture, 03 §2.1 [9][40][87]).
- **Confirm:** type-nothing single confirm `Dialog` (destructive-styled), disabled while the
  merge mutation is in flight; success toast + the pair leaves the queue; failures surface the
  RFC 9457 detail. Daily-cap exhaustion renders the honest 429 copy with the reset time.

### §6 Error-reporting UX (G14 presentation half) 🔲

#### §6.1 Grouped errors + row drill-in

On the job page's Errors tab: errors **grouped by typed code** (the 08 §4 taxonomy — one
vocabulary across preview, ledger, artifacts), each group: plain-language title, impact count,
affected columns, expandable first-N rows (row number, column, offending value **rendered from
the artifact contract's redaction rules only** — the UI never displays a value the error report
would redact, 13's `_REDACTED_` pass). Warnings render as a separate band (landed-with-anomaly,
05 §4 — never conflated with failures). Row-level drill-in pages through `import_job_rows` via
08 §7's paginated detail read.

#### §6.2 The two artifacts

Two download rows (08 §6.2): **Repair file** ("your original columns plus `tp__error_code` /
`tp__error_detail` — fix and re-import") and **Error report** ("errors grouped by type, with
counts"). Both rows carry: a PII notice ("Contains data from your file — handle accordingly")
and the audit notice **"Downloads are logged"** (10 §7's in-tx audit; the HubSpot
who-downloaded precedent, 03 §5.1 [7]). Gate per 10 §2.1 (creator ∪ elevated; never widened by
sharing); signed expiring URLs — an expired link re-requests transparently. Non-entitled
viewers see the disabled-with-reason row (§2.3).

#### §6.3 Retry-failed-rows flow

"Retry failed rows" (job page + drawer + completion notification action) → `Dialog`: "Re-run
{N} failed and never-attempted rows with the same mapping and settings" + an "Edit settings
first" secondary that opens the wizard prefilled at W2 (parent linkage preserved). Submit →
child job (08 §6.3) → navigate to the child's job page; the parent page shows the retry chain.
Replay-safe (Idempotency-Key; same child on double-click).

### §7 Responsive & accessibility (WCAG 2.2 AA) 🔲

#### §7.1 Keyboard model — the mapping table (explicit)

W2's mapping table is an ARIA grid with **roving tabindex**: `Tab` enters the grid at the last
active cell and the next `Tab` exits it (one stop in the page tab order); `↑/↓` move rows,
`←/→` move between source-info and target-control cells; `Enter`/`Space` opens the `Combobox`
(its own listbox keyboard model applies; `Esc` closes back to the cell); typeahead within the
Combobox; `Delete` on a mapped cell sets "Don't import" (announced). The blockers strip items
are links that move focus to the offending row. All wizard controls reachable without a
pointer; drag-drop upload has the file-picker equivalent.

#### §7.2 Focus management & announcements

- **Step transitions:** on W-step change, focus moves to the new step's `h2`
  (`tabIndex={-1}`), the step indicator updates `aria-current="step"`, and the document title
  updates ("Import — step 3 of 5").
- **Progress:** one polite `aria-live` region on the job page announces coarse transitions and
  throttled progress ("Importing — 40 percent, 8,000 of 20,000 rows" at most every 10 s — never
  per poll tick); terminal states announce assertively once. The percent bar itself is
  `role="progressbar"` with `aria-valuenow` (the DS `Progress` already carries a label).
- **Drawers/dialogs:** DS focus-trap + return-focus (never hand-rolled); destructive confirms
  are real dialogs, not toasts.
- Status is never color-alone (badge text + icon); tones meet AA contrast on the light theme;
  targets ≥ 44 px (`--tp-row-h`); reduced-motion respected (progress interpolation becomes
  stepped).

#### §7.3 Mobile behavior (decided and stated)

- **375 px:** History = a card list (file, status badge, progress, one-line counts) — **read +
  act**: drawer opens full-screen; Cancel and artifact download work; no table. Wizard: W1/W4/W5
  fully usable (single column); **W2/W3 degrade to stacked per-column cards** — functional but
  labeled "easier on a bigger screen" (an honest hint, not a block). Duplicate review: queue
  readable, dismiss works; the merge panel requires ≥768 px (side-by-side below that is
  malpractice) — Review renders a "Continue on a larger screen" state.
- **768 px:** everything works; mapping table two-pane; merge panel stacks the two records with
  a sticky record switcher.
- **1280 px:** full layouts as specced.

### §8 Component & feature-folder plan 🔲

#### §8.1 Component map (all `@leadwolf/ui` by name)

| Surface | Components |
|---|---|
| History page | `DataTable`, `Pagination`, `StatusBadge`, `Progress`, `Avatar`, `Badge`, `TpSelect`, `SegmentedControl`, `DropdownMenu`, `Tooltip`, `StateSwitch` kit, `PageHeader` (app shared) |
| Detail drawer | `Drawer`, `StatTile`, `StatusBadge`, `TpButton`, `Dialog` (cancel confirm), `Alert` |
| Wizard | `RadioGroup`/`RadioOption`, `TpInput`, `TpSelect`, `TpSwitch`, `TpChip`, `Combobox` (mapping targets + templates), `Dialog` (create-field, save-template), `FormSection`/`FieldGroup`/`FormRow`, `StatTile` (projection), `DataTable` (sample grid), `Alert`, `TpButton`, `useToast` |
| Job page | `Progress`, `StatusBadge`, `StatTile`, `Tabs` (Overview/Errors), `TpButton`, `Dialog` |
| Duplicates | `Tabs`, `DataTable`, `TpChip`, `Drawer`/`Dialog`, `RadioGroup` (per-field picks), `Badge`, `Tooltip`, `useToast` |
| Home card | existing `WidgetCard` + `SegmentedControl`, `Avatar` |

#### §8.2 Feature folders, hooks, query keys (TanStack — the adoption point)

`apps/web/src/features/import/` restructures (names final at PR; sizes per the 150-line rule):

```
features/import/
├── index.ts                      # public barrel
├── keys.ts                       # importKeys.list(filters) · .detail(id) · .draft(id) · .templates()
├── api/                          # thin fetchers per endpoint (split from today's api.ts)
├── hooks/
│   ├── useImportsList.ts         # useQuery(keys.list) + conditional 10s refetchInterval
│   ├── useImportJob.ts           # useQuery(keys.detail); refetchInterval fn per 09 §4.3, off on terminal
│   ├── useImportDraft.ts         # draft CRUD + preview mutations (wizard server state)
│   ├── useCommitImport.ts        # commit/cancel/retry mutations (Idempotency-Key; invalidate list+detail)
│   └── useMappingTemplates.ts
├── components/
│   ├── history/                  # ImportsPage, ImportsTable, ImportRowActions, ImportDrawer, StatusTimeline
│   ├── wizard/                   # ImportWizardPage, StepUpload, StepMapping, MappingGrid, TemplateBar,
│   │                             #   CreateFieldDialog, StepPreview, StepStrategy, StepReview
│   ├── job/                      # ImportJobPage, CompletionSummaryBar, ErrorGroups, ArtifactRow, RetryDialog
│   └── shared/                   # stateCopy.ts (the §4.2 table), countLabels.ts
└── copy.ts                       # i18n-keyed strings (§4.2 pinned here)
```

Duplicate review is its **own feature folder** `features/duplicates/` (queue + merge panel +
`duplicateKeys`) since its inflow and route are not import-owned (§1.3); it absorbs the shipped
`features/data-health` duplicates pieces (`DuplicatesSection.tsx`, `useDuplicatePairs.ts`, the
`fetchDuplicatePairs`/`unmarkDuplicate` fetchers in its `api.ts`), which retire with the S-U8
cutover. Retired with their
surfaces: `useImport.ts` (the give-up poller), `ImportPage.tsx`, `ImportWizard.tsx` (superseded
by `wizard/`), `rejectedRowsCsv.ts` (client-built CSV — replaced by server artifacts);
`BulkImportProgress.*` folds into `job/`. `useContacts`/`ContactsTable` move out with the
`/import` route retirement (their real home already exists). Server state lives only in query
hooks; wizard step state is a local reducer (client state — never in the query cache); no
component calls the API client directly.

#### §8.3 DS gaps (WIRE — flagged, not hand-rolled raw)

| Gap | Needed by | Interim |
|---|---|---|
| **Virtualized table mode for `DataTable`** (its header names the TanStack swap as follow-up) | §2, §5, §6 row drill-in | server keyset pagination (50/page) keeps DOM bounded; upgrade is drop-in |
| **`Stepper`** (wizard step indicator) | §3 | token-styled ordered list with `aria-current="step"`, built as a candidate DS component in the feature, promoted to `@leadwolf/ui` when stable |
| **`FileDropzone`** | W1 | styled `TpInput type="file"` (shipped pattern) + drop handler on a `Card` |
| **`Timeline`** | §2.3 | token-styled list |
| **`DiffFieldRow`** (side-by-side value pair + pick) | §5.2 | composed from `RadioGroup` + grid styles; promotion candidate |
| **`LiveAnnouncer`** (shared polite/assertive region) | §7.2 | local `aria-live` div util in `features/import/shared` |
| **`info` tone for `StatusBadge`** (optional — shipped `StatusTone` is `success\|warning\|danger\|muted`, `StatusBadge.tsx:5`) | §2.2/§4.2 non-terminal states | `muted` (monochrome system: color stays the exception); adopt only if the DS adds the tone |

#### §8.4 Four-states audit (every new surface × `StateSwitch`)

| Surface | Loading | Empty | Error | Populated |
|---|---|---|---|---|
| History page | table skeleton (`LoadingState rows=8`) | first-run: "Import your first file" + CTA → wizard; filtered-empty: "No imports match" + clear-filters | `ErrorState` + retry | §2.2 |
| Detail drawer | drawer skeleton | n/a (opened from a row) | inline `ErrorState` + retry | §2.3 |
| W1 upload | n/a (static) | pre-file state IS the surface | file-read/validation `Alert` | file card + pre-checks |
| W2 mapping | header-parse skeleton | "No columns found in this file" + re-upload | parse `ErrorState` | grid |
| W3 preview | projection skeleton (server pass may take seconds — progress note on big files) | 0-row file blocked upstream (08 edge) | `ErrorState` + re-run preview | §3-W3 |
| W4 strategy | defaults loading skeleton | n/a (static options) | policy-load fallback to code defaults + warning | §3-W4 |
| Job page | page skeleton | "No import job found" (absent/expired — shipped copy kept) | `ErrorState` + retry (poll continues through blips — 3-consecutive-error tolerance kept) | §4 |
| Duplicates queue | table skeleton | "No duplicates waiting for review" 🎉 | `ErrorState` + retry | §5.1 |
| Merge panel | pair skeleton | pair already resolved → "Already handled" + refresh queue | `ErrorState` | §5.2 |
| Company-match tab | table skeleton | "Nothing to review" | `ErrorState` | §5.1 |
| Recent Imports card | shipped `WidgetCard` states | member/elevated copy split (§1.5) | shipped | §1.5 |

---

## Pre-build reasoning pass (explicit answers — frontend delta; 08/09/10 own the backend passes)

- **Source of truth.** Job state/counters: the server row via query hooks — the UI derives
  nothing (percent/stage come server-derived, 09 §4.1; the completion bar re-labels, never
  re-computes). Wizard progress: local reducer + the server draft (Phase B) — on conflict the
  server draft wins at resume. Visibility: server-enforced (10) — client controls only switch
  which query is asked for; hiding is UX, never the boundary. Copy: `copy.ts` keyed for i18n.
- **Optimistic vs server-truth.** **Server-truth everywhere on this feature.** No optimistic
  job-state updates (a job is a server fact); mutations show in-flight button state, then
  invalidate `keys.detail`/`keys.list`. The two bounded exceptions: dismiss-duplicate removes
  the row optimistically with rollback-on-error (cheap, reversible); template save updates the
  local template list from the mutation response (the shipped pattern, kept).
- **Failure modes.** *Poll blips:* keep last data + silent retry (3-consecutive tolerance —
  shipped discipline, kept); only sustained failure surfaces `ErrorState`, and the poll resumes
  on retry — **there is no give-up state in the contract** (09 §4.3). *Commit network failure:*
  Idempotency-Key replay-safe retry button. *Slow network:* skeletons per §8.4; preview shows a
  "still working" note past 5 s; uploads show byte progress (Phase B multipart). *Expired
  session mid-wizard:* the 401 interceptor routes through re-auth and returns to
  `/imports/new?step=n` — draft state survives server-side (Phase B) / localStorage-draft-free
  honesty pre-Phase-B (§3's leave prompt). *Flag off mid-session:* nav entry hidden, routes
  render the honest "not enabled" state (the shipped `disabled`-state pattern), never a 500.
- **Duplicate prevention.** Buttons disable on first fire; commit/retry/cancel carry
  Idempotency-Keys (08 §2.3); dismiss/merge are server-idempotent; the wizard cannot
  double-commit (post-202 it navigates away).
- **Audit.** All actor verbs audited server-side (08 §7, 10 §7); the UI adds the §6.2
  "downloads are logged" honesty line. No client-side audit writes.
- **Security.** No PII rendered beyond what endpoints return (masked stays masked; error values
  obey the redaction contract §6.1); artifact links are server-signed and expiring — never
  constructed client-side; role/visibility logic renders server answers (10 §2.1), never
  computes them; presets (`listId`) are suggestions the server re-validates; no secrets in the
  bundle (`NEXT_PUBLIC_` discipline).
- **Scalability (frontend).** One list poll, not per-row; keyset pages of 50; drill-ins
  paginated; aria-live throttled; SSE later replaces polling as garnish only (09 §4.4 — no
  behavior may require it). At 10x jobs the page cost is constant (pagination).
- **Monitoring.** Frontend analytics events: wizard step-completed (funnel per step — the
  abandonment metric), commit, navigated-away-while-running, notification-clicked,
  artifact-downloaded, retry-started, duplicate-reviewed/dismissed/merged. Errors surface via
  the standard client error reporting; the give-up copy's removal is grep-testable.
- **Rollback.** Every surface behind the dual gates (§Rollout); flag-off = current UI
  byte-identical except the S-U1 toggle removal (deliberate, safe — it only removes a 403
  generator). No frontend data migrations exist to roll back.
- **Worst case.** *The UI shows the wrong workspace's or user's jobs:* impossible client-side —
  scoping is server-enforced (10 T-V1/T-V3); the client never widens a query beyond what the
  role's endpoints return. *A user believes cancel undoes an import:* the confirm dialog states
  the opposite in one sentence, the terminal copy repeats it, and the summary bar shows what
  landed — three honest touchpoints (09 §9).

---

## Implementation Steps (step IDs — doc 15 sequences; no DDL anywhere in this doc)

| Step | What ships | Depends on |
|---|---|---|
| **S-U1** | **Toggle kill** (flag-independent; full removal-cleanup incl. palette entry) + TanStack Query adoption (dep + provider) + route scaffolding: `/imports` section inside `(shell)`, `/import` redirect, navConfig destination + `sectionTitleFor` cleanup | — |
| **S-U2** | History page + detail drawer over 08 S-I4's list/detail (ships only with 10's predicate — 08 §7) + row actions (cancel per S-I4) | 08 S-I4, 10 S-V3 |
| **S-U3** | Durable job page generalization (all imports; §4.2 copy table; completion summary bar; cancel confirm) + delete `useImport` poller + wizard submit → navigate | 08 S-I3 |
| **S-U4** | Wizard v2 (five steps over the legacy one-shot: client pre-validation, mapping grid + Combobox + channel slots, template bar + visibility, create-field dialog, preview render, strategy step, review) | 08 S-I5/S-I6; S-I2 |
| **S-U5** | Notifications: in-app "Import finished" rendering + deep link + Settings row; Recent Imports card split (§1.5) | 09 S-Q4, 10 S-V3 |
| **S-U6** | Error UX: grouped errors, row drill-in, artifact rows w/ notices, retry-failed dialog + chain rendering | 08 S-I7/S-I10 |
| **S-U7** | Draft-flow upgrade (Phase B): upload-once, resume-draft affordances, `?step=` resume, draft reap copy | 08 S-I8 (**G07**) |
| **S-U8** | Duplicate review: Data Health tab, queue + filters, dismiss (single/bulk), merge panel, company-match tab | 04 S-C4-family merge API; 06 §5; S-U2 |

## UI/UX

This entire doc is the series' UI/UX artifact — §1–§8 are normative. Sibling docs' UI/UX
sections point here and are consumed above (08 §UI/UX, 09 §UI/UX, 10 §UI/UX).

## DB & Backend (summary)

**None.** Zero DDL, zero API additions from this doc — every surface renders 08 §2.3's verbs,
09 §4's progress contract, and 10 §2.1's matrix. Anything a screen needed that the contracts
lacked was pushed into those docs during drafting (nothing remains outstanding).

## API (summary)

Consumer only: `GET/POST /imports…` + verbs (08 §2.3), notifications (09 §6.3), policy defaults
(10 §3), merge/dismiss (04 §API), company-match resolution (06 §5). The UI treats problem
`type` slugs as the switch key for copy (e.g. `import_quota_exceeded`, `illegal_state`,
`import_disabled_by_policy`) — never string-matches `detail` text.

## Edge Cases

Covered in the pre-build pass and: duplicate headers force explicit mapping (W2 blockers, 08
§3.2) · template applied to mismatched file ("n of m matched") · preview stale after mapping
edit (invalidate, kept) · job page for a foreign/absent id → the shipped not-found empty state
(404 indistinguishable, 10 §7) · `paused` renders read-only support copy (08 §2.1) ·
zero-reject completion hides the Errors tab entirely · cancel racing terminal → 409 rendered as
"already finished" refresh · merge pair where one record was deleted meanwhile → "Already
handled" (§8.4) · list preset for a deleted list → chip renders with a server-validation error
at commit, wizard continues without the list · legacy jobs without `source_filename` fall back
to source label (§2.2).

## Testing (hooks — CI-run; this sandbox cannot execute gates)

- **T-U1 (component)** Wizard step gating: cannot pass W2 with unmapped required fields; W3
  invalidates on mapping change; W4 defaults load from policy; W5 disables after fire.
- **T-U2 (component)** State-copy table: every 08 §2.1 state renders exactly the §4.2 string +
  tone; unknown enum renders the muted-tone fallback copy (future-proof case).
- **T-U3 (component)** Four-states: every §8.4 surface renders all four via `StateSwitch`
  (storybook-level render tests).
- **T-U4 (a11y)** Mapping grid keyboard model (§7.1) — axe + keyboard-walk tests; focus moves to
  step heading on transition; aria-live throttling.
- **T-U5 (component)** Visibility rendering: member sees no scope toggle and no Created-by
  column; elevated sees both; artifact rows disabled-with-reason for non-entitled (mocked per
  10 §2.1 — enforcement itself is 10's T-V suite).
- **T-U6 (e2e)** The G11 arc: upload → commit → navigate away mid-run → notification → job page
  → completion bar → artifact download → retry-failed child.
- **T-U7 (e2e)** Duplicate arc: import flags duplicates → queue link → dismiss one, merge one
  (pin stays locked) → queue empties.
- **T-U8 (grep)** The give-up copy ("taking longer than expected"), the `largeFile` state, and
  `act-bulk-import` no longer exist in the codebase.

## Rollout

S-U1 ships first and flag-free (toggle kill + scaffolding; the new nav entry hides behind the
dual gate until S-U2 gives it a page). S-U2–S-U6 ride 08's `IMPORT_V2_ENABLED` dual gate
(internal workspaces → per-tenant canary); the §1.5 card and scope controls ride 10's
`JOB_VISIBILITY_SCOPED` gate and its comms plan. S-U7 waits for G07 (Phase B). S-U8 rides the
merge feature's own dual gate (04 §Rollout). Flag-off at any point = the current UI, minus only
the dead toggle. Phase placement: doc 14; sequencing: doc 15.

## Success Metrics

- **Wizard abandonment rate** per step (funnel events) — baseline captured at S-U4 ship;
  W2-mapping abandonment is the leapfrog's KPI (templates should cut repeat-import mapping time
  to near zero).
- **Time-to-first-import** for new workspaces (signup → first `completed` job) trends down.
- **"Stuck/broken import" support tickets** ↓ (shared with 08's metric); zero tickets citing the
  Large-file toggle or the give-up message (both no longer exist — T-U8).
- **G11 behaviorally closed:** ≥ X% of >1-minute imports see the user navigate away and return
  via notification/history (the flow works as designed, measured); 0 sessions stuck watching a
  dead poll.
- **Duplicate queue throughput:** markers reviewed (merged or dismissed) per week > markers
  created (the debt shrinks); merge-confirm error rate ~0.
- **A11y:** axe-clean on all §8.4 surfaces; keyboard-only completion of the full wizard verified
  in CI (T-U4).
- **Card correctness:** post-flip, member home cards show only own imports (10 T-V1's UI
  mirror), with 0 confusion-ticket regressions after the comms.
