# Email — The /web Customer Surface (10)

> Cites the **Locked Decisions (D1–D11)** and the **Shared Vocabulary / Canonical Entities** in
> `00-overview.md` (read through the ground-truth name mapping in `14-current-state-integration.md`),
> the **Phase Map** in `13-rollout-phases.md`, and the **roles matrix** in `12-roles-permissions.md`.
> This doc owns the **customer/staff-facing surface** of the email subsystem inside `apps/web` (the
> customer app): every tab/page the rep, manager, and workspace-admin touch, where the feature code
> lives, and how email slots into the existing AppShell. It is **surface + wiring**, not new subsystems —
> the engines (templating, sending, deliverability, tracking, sequences, suppression, analytics) are
> specified in their own deep docs and this doc only *consumes* their DTOs and *renders* their
> triggers/states.
>
> **The one rule above all others (D11 — build on, don't duplicate).** TruePoint **already ships** the
> M9 suppression-gated outreach send engine. This surface **wires** the real shipped tables and code —
> `outreach_sequences` / `outreach_steps` / `outreach_log` (Sequence/Step/Enrollment), `activities` (the
> engagement timeline), `suppression_list` + `assertNotSuppressed` (the D4 gate), `consent_records` (D9),
> `idempotency_keys` (D5), `audit_log`, and the `EmailSenderPort` seam — and **never invents** parallel
> `email_sequence` / `email_sequence_step` / `email_enrollment` / `email_suppression` / `email_consent` /
> `email_idempotency_key` tables. Every tab below either **already exists** in `apps/web/src/features/*`
> and needs the real backend wired behind it, or is the **one genuinely new** settings page. This is
> **M12 (extend M9)**, not a greenfield build. See `14` §2/§5/§6 for the full name mapping and milestone
> framing.
>
> This document mirrors `docs/planning/list-plan/04-list-workspace-ui.md` in shape and tone:
> prescriptive, contract-like, **reuse-over-rebuild**, four-states-mandatory, owner-scoped-by-default.
>
> **The data-fetching pattern (canon — there is no TanStack Query / `useQuery` / query-keys in this app).**
> Every async surface in `apps/web` is **vanilla React**: a hook holds `useState` for `{ data, loading,
> error }` and a `useCallback` `reload`; `api.ts` issues `fetchWithAuth` calls (in-memory access token,
> ADR-0016); list reads return a **`MaybeList<T> = { items, available }`** envelope that reports
> `available: false` on a `404`/`501` (a not-yet-wired backend) so the surface shows a "connect …"
> `EmptyState` instead of an error; the UI renders four states through **`StateSwitch`**
> (`loading`/`error`/`empty`/`data`) + `EmptyState` from `@leadwolf/ui`; **mutations reload** (no
> optimistic UI in MVP) and carry **per-action pending state**. The reference implementation is the
> built **Sequences** slice (`apps/web/src/features/sequences/{api.ts, hooks/useSequences.ts}`). Do not
> introduce a query cache, query keys, or `useQuery`.
>
> **Scope boundaries (read these first):**
> - **Templating / merge fields / versions** → `01-templating.md`. The Templates tab is the *editor and
>   library shell*; the merge-field grammar, version semantics, and rendering rules are `01`.
> - **Sending infra / mailbox connect / domains / warmup** → `02-sending-infrastructure.md`. The
>   Mailboxes page renders the **OAuth connect flow and health chips** (D7); the `mailbox_integration` /
>   `sending_domain` provider math and the `EmailSenderPort` adapter are `02`.
> - **Deliverability mechanics** (SPF/DKIM/DMARC, bounce classes, reputation pools, warmup curves) →
>   `03-deliverability.md`. The Deliverability tab *visualizes* those signals; it does not compute them.
> - **Tracking + inbox threading** (open/click/reply events, thread reconciliation) →
>   `04-status-event-tracking.md`. The Unified Inbox renders threads; the `activities` + raw `email_event`
>   pipeline is `04`.
> - **Sequence engine** (steps, scheduling, branching, enroll/fan-out) → `05-sequences-automation.md`.
>   The Sequences tab is the *builder and enrollment surface*; the `outreach_log` runtime is `05`.
> - **Compliance / unsubscribe / consent** → `06-compliance.md`. The Suppression surface renders the
>   `suppression_list` and the unsubscribe affordance; the legal/enforcement rules are `06` (D4, D9).
> - **Analytics computation** → `08-reporting-analytics.md`. The Analytics tab renders funnels; the metric
>   definitions (esp. **opens are informational, not a KPI — D6**) are owned by `08`.
> - **Schema / real DTOs** (`outreach_sequences`, `outreach_log`, `mailbox_integration`, `sending_domain`,
>   `email_event`, … ) → `09-data-model.md`, reconciled to the shipped names by `14`. This doc consumes
>   those DTOs; it does not define them.
> - **Roles / who-sees-what matrix** → `12-roles-permissions.md`. This doc states the owner-scope *default*
>   (D8) per tab and defers the full role matrix to `12`.
> - **Admin/staff console** (per-tenant reputation, break-glass via the `apps/admin` Users impersonation,
>   ops) → `11-admin-surface.md`. That is `apps/admin`; this doc is the **customer** app `apps/web`.

---

## 1. Navigation & routing — slotting email into the existing shell

### 1.1 The shell already owns Sequences and Inbox — email **lands inside the real, shipped surfaces**

`apps/web/src/components/shell/navConfig.ts` is **the single source of truth** for navigation — the
rail, the top-bar section title, the command palette, and the settings scope-nav all read it (its header
comment: "add a destination in exactly one place"). The current `DESTINATIONS` array is real and
shipped: **Home · Prospect · Lists · Sequences · Inbox · Reports**, plus a pinned **Settings**.

The email work is **not a new product** — it **wires real backends behind tabs that already render**:

- **`Sequences`** (`/sequences`) is **fully built** today (`features/sequences/components/SequencesPage.tsx`):
  a `Tabs` switch over `SequenceList`, `SequenceBuilder`, `EnrollmentPanel`, `EnrollmentLogTable`,
  `SendStatusDashboard` (a send funnel), a **Templates panel that is a stub** (`TemplatesPanel.tsx` —
  `fetchTemplates` returns `{ available: false }` until the backend exists), and an AI `DraftReviewPanel`
  stub. The email subsystem **deepens** these against the real `outreach_*` API.
- **`Inbox`** (`/inbox`) is built as a **contract** (`features/inbox/components/InboxPage.tsx`: `ThreadList`,
  `ThreadView`, `TasksPanel`) but the reply/task backends answer `404`/`501` (`available: false`) — the
  **Unified Inbox** *is* the Replies experience, deepened with mailbox sync + thread reconciliation (`04`).
- **`Reports`** (`/reports`) is built (`features/reports/components/ReportsPage.tsx`) with six sections;
  the **`DeliverabilitySection`** is a **placeholder** today (`StatTile` "—", a "Connect sending"
  `EmptyState`). Email **wires the deliverability + send metrics** behind it (§6, §7).

The decision (recorded here; the final tab order is a `truepoint-design` call): **do not add a parallel
`/email` rail destination that competes with Sequences/Inbox/Reports.** A second top-level "Email" icon
next to the three doors that already own this workflow would split the rep's mental model. Instead the
email subsystem maps onto the **existing rail destinations** plus **one new settings-scope page**:

| Subsystem tab | Surface it wires | Status today | Route |
|---|---|---|---|
| **Sequences** | `features/sequences` (built) | **Built** — wire real email send via `EmailSenderPort` | `/sequences` → Sequences tab (default) |
| **Templates** | `features/sequences` `TemplatesPanel` (stub) | **Stub** — wire the `/api/v1/templates` backend + build the editor | `/sequences?view=templates` |
| **Unified Inbox** | `features/inbox` (contract; 404/501) | **Contract** — wire mailbox sync + reply composer | `/inbox` → Replies tab |
| **Deliverability** | `features/reports` `DeliverabilitySection` (placeholder) | **Placeholder** — wire `sending_domain`/reputation metrics | `/reports` → Sending & deliverability |
| **Analytics** | `features/reports` (built funnel) + `features/sequences` `SendStatusDashboard` | **Wire metrics** — feed from `activities` + `email_event` | `/reports` (funnel) + `/sequences` (per-sequence) |
| **Suppression** | `features/settings-compliance` (built) | **Built — reuse as-is** | `/settings/compliance` |
| **Mailboxes** | `features/settings-mailboxes` (**new**) | **NEW** — create the slice + add a navConfig entry | `/settings/mailboxes` |

> **Why Settings for Mailboxes + Suppression.** Both are **workspace-configuration** surfaces, not
> daily-work surfaces, and the shipped `SETTINGS_NAV` already reserves a **Workspace** scope with a
> **"Suppression & DSAR"** item (`/settings/compliance` — `features/settings-compliance`, fully built:
> `SuppressionForm`, `SuppressionList`, `DsarForm`). Mailboxes is connect-once / manage-rarely
> infrastructure that belongs beside other workspace config (General, Members, Auto-enrich, Custom fields,
> Compliance). Putting both in Settings keeps the daily rail (Sequences/Inbox) about *doing* and Settings
> about *configuring*.

This honours the canon Phase Map (`13`): **Mailboxes lands early (P1)** as a settings page since the
send tx (`sendStep.ts`) needs a connected, non-console sender; **Suppression with compliance (P1+)** is
already the built compliance page; **Templates (P2)**, **Unified Inbox (P3)**, **Sequences send (P4)**,
**Deliverability + Analytics (P5)** then deepen the existing surfaces phase-by-phase.

### 1.2 The coordinated `navConfig.ts` edit (the only nav change)

Because Sequences, Inbox, and Reports are **already destinations** and Suppression is **already a
settings item**, the rail icons and the compliance entry need **no change**. The only required edit lives
in `navConfig.ts` and is the **new Mailboxes settings entry** plus optional palette quick-actions:

1. **`SETTINGS_NAV` → Workspace scope** — add the **Mailboxes** item beside the existing
   "Suppression & DSAR" → `/settings/compliance` (which already exists):
   ```ts
   { label: "Mailboxes", href: "/settings/mailboxes", match: "/settings/mailboxes" }
   ```
   `sectionTitleFor("/settings/…")` already returns "Settings" for any settings path, so no title branch
   is needed.

2. **`PALETTE_QUICK`** — add keyboard-reachable quick actions for the email primary jobs (the rail
   destinations are already in `PALETTE_NAVIGATE` for free, since it is generated from `DESTINATIONS`):
   ```ts
   { id: "act-new-template",  label: "New email template", href: "/sequences?view=templates&new=1", keywords: ["email","template","snippet"] },
   { id: "act-new-sequence",  label: "New sequence",       href: "/sequences?new=1",                 keywords: ["cadence","outreach","email"] },
   { id: "act-connect-mailbox", label: "Connect a mailbox", href: "/settings/mailboxes?connect=1",   keywords: ["gmail","outlook","oauth","email","mailbox"] },
   ```
   The `?view=`, `?new=1`, `?connect=1` params are read on mount, open the right tab/dialog, then clear
   from the URL — mirroring how the Lists surface uses `?new=1`/`?import=1` (list-plan/04 §1.1).

3. **No `DESTINATIONS` edit.** Adding a destination here would be the regression: the rail, top bar, and
   palette already resolve Sequences/Inbox/Reports. Editing `Sidebar`/`AppShell`/`CommandPalette`
   directly is forbidden by the same rule (the `navConfig.ts` header comment).

### 1.3 Routes (App Router, under the `(shell)` group)

The `(shell)` route group wraps every signed-in destination in `AppShell` (rail + top bar + auth gate)
via `apps/web/src/app/(shell)/layout.tsx`. Email **reuses the existing routes** and adds **one new
settings route**. Every route file stays ~10 lines (import + `dynamic` + default export); all behavior
lives in the slice.

| Route file | Renders | Notes |
|---|---|---|
| `app/(shell)/sequences/page.tsx` (exists) | `<SequencesPage/>` from `@/features/sequences` | `force-dynamic` — reads `?view=`/`?new=1` from the URL (`useSearchParams`), same reason `prospect`/`lists` are force-dynamic. Hosts the **Sequences · Templates** tabs and the **Send status** funnel (§3, §4, §7). |
| `app/(shell)/inbox/page.tsx` (exists) | `<InboxPage/>` from `@/features/inbox` (Replies tab = unified inbox) | `force-dynamic` — thread filter read from URL. The **Unified Inbox** (§5). |
| `app/(shell)/reports/page.tsx` (exists) | `<ReportsPage/>` from `@/features/reports` (Sending & deliverability section) | `force-dynamic` — the **Deliverability + Analytics** read models (§6, §7). |
| `app/(shell)/settings/mailboxes/page.tsx` (**new**) | `<MailboxesPage/>` from `@/features/settings-mailboxes` | `force-dynamic` — `?connect=1` opens the OAuth connect flow (§4.4). Lives in the Settings layout's Workspace scope. |
| `app/(shell)/settings/compliance/page.tsx` (exists) | `<CompliancePage/>` from `@/features/settings-compliance` | The **Suppression** surface (§8), **already built** — reused as-is. |

> **IDOR is a 404, not a leak (Security, final say).** Every email route reads IDs from the URL but
> **never trusts them as an access grant**. A `sequenceId`, `logId` (enrollment), `mailboxId`, or
> `threadId` that is not in the caller's `tenant_id`+`workspace_id` (and, where owner-scoped, not visible
> to the caller) resolves **404 server-side** below the app layer (RLS, `07`); the page renders
> `ErrorState`/not-found, never another tenant's or another rep's data (D8). The client tab/route is
> convenience; the wall is RLS + ownership re-resolved server-side in the API (`12`).

### 1.4 The feature slices — wire the real ones, create one

The email subsystem is **not one new slice** — it is the **wiring of four existing slices** plus **one
new settings slice**. Each keeps the shipped `features/*` shape (canon FILE-STRUCTURE REFERENCES): an
`api.ts` (the only network seam, `fetchWithAuth`), a `types.ts` (view-models + centralized copy/label
maps, i18n-ready, consuming `@leadwolf/types` DTOs type-only), `hooks/` (vanilla-React `useState` +
`useCallback` `reload`, `MaybeList` for not-yet-wired backends), `components/`, and a `*.module.css`
(tokens-only, `var(--tp-*)`).

**Existing slices the email work wires (do not re-scaffold):**

```
apps/web/src/features/sequences/        # BUILT — wire real email send + the templates backend
  api.ts        # fetchWithAuth over /api/v1/outreach/* + /api/v1/templates; ApiError ← RFC 9457; MaybeList for templates/drafts
  types.ts      # SequenceSummary/SequenceMetrics/EnrollmentEntry/TemplateSummary + status→StatusBadge tone maps + MERGE_FIELDS
  components/    # SequencesPage, SequenceList, SequenceBuilder, EnrollmentPanel, EnrollmentLogTable,
                 #   SendStatusDashboard (funnel), TemplatesPanel (STUB → wire), DraftReviewPanel (STUB)
  hooks/         # useSequences, useSequenceBuilder, useEnrollment, useEnrollableContacts, useTemplates, useDrafts

apps/web/src/features/inbox/            # CONTRACT (404/501) — wire mailbox sync + reply composer
  api.ts        # fetchThreads/fetchThread/updateThread/sendReply/fetchTasks/updateTask; notBuilt(404/501)→available:false
  types.ts      # InboxThread{channel email|linkedin, messages, assigneeId, sequenceId}, InboxTask{source manual|reply|…}
  components/    # InboxPage, ThreadList, ThreadView, TasksPanel

apps/web/src/features/reports/          # BUILT funnel — wire deliverability + send metrics
  components/    # ReportsPage + DeliverabilitySection (PLACEHOLDER → wire), FunnelSection, …

apps/web/src/features/settings-compliance/   # BUILT — reuse the Suppression surface AS-IS
  api.ts        # addSuppression/listSuppressions/removeSuppression/submitDsar over /api/v1/compliance/*
  components/    # CompliancePage, SuppressionForm, SuppressionList, DsarForm
```

**The one new slice (P1):**

```
apps/web/src/features/settings-mailboxes/    # NEW — the only greenfield surface in this doc
  api.ts                # fetchWithAuth over /api/v1/mailboxes/* + the OAuth connect handoff; MaybeList while the backend lands
  types.ts              # MailboxSummary (address, provider, health, daily used/limit, warmup, lastSyncAt) + health-chip tone map
  index.ts              # public barrel: { MailboxesPage }
  mailboxes.module.css  # tokens-only (var(--tp-*))
  components/
    MailboxesPage.tsx    # connected mailboxes list + "Connect a mailbox" CTA + health chips (§4.4)
    ConnectMailboxDialog.tsx  # launches the OAuth flow; never displays/accepts/stores secrets (D7)
  hooks/
    useMailboxes.ts      # vanilla-React list + connect/disconnect/pause/resume; reload-on-mutate; never reads secrets (D7)
```

**Reused from sibling slices, not copied** (cross-slice via each slice's public `index.ts` barrel, the
allowed seam — the same `boundaries`-lint rule as list-plan/04 §1.3): the `DataTable`/`Column` machinery
and bulk selection from `features/prospect`/`features/lists` for the **Send history** and **Suppression**
tables, the masking helpers where recipient PII is shown, `currentUserId` for the "mine vs all"
owner gate (D8 across tabs), and `RecordDetail` for "open the contact" (§5, §5.3). No new primitives —
everything composes `@leadwolf/ui`.

---

## 2. The API seam — `api.ts` typed fetch wrappers (consume the real `/api/v1/outreach`, don't define)

Each slice's `api.ts` is a thin typed client and the **only** place the slice talks to the network — it
rides **`fetchWithAuth`** (the in-memory access token, ADR-0016) and never touches the DB or auth origin
directly. The shipped reference is `features/sequences/api.ts`, which already calls the real
`/api/v1/outreach/*` routes (`apps/api/src/features/outreach/routes.ts`). It:

- **Calls the real, shipped routes, not invented ones.** Sequences: `GET/POST /outreach/sequences`,
  `PATCH /outreach/sequences/:id` (pause/resume), `POST /outreach/sequences/:id/steps`,
  `POST /outreach/sequences/:id/enroll` (**201 new / 200 already-enrolled** against the
  `UNIQUE(sequence_id, contact_id)` idempotency), `/enroll-bulk`, `GET /outreach/sequences/:id/log`,
  `POST /outreach/log/:id/send`, `POST /outreach/log/:id/bounce`. Templates: `GET /api/v1/templates`
  (not yet wired → `MaybeList { available: false }`). Inbox: `/api/v1/inbox*`, `/api/v1/tasks*`.
  Suppression: `/api/v1/compliance/suppression*` (built). Mailboxes: `/api/v1/mailboxes*` (new).
- **Maps RFC 9457 problem responses to a typed `ApiError`** carrying the stable machine `code` — exactly
  the shipped `features/sequences/api.ts` `ApiError`/`toApiError` pattern, so the send tx's CAN-SPAM block
  (`422`), the suppression gate (`403 "suppressed"`), and `validation_error` (`422`) surface the server's
  message **verbatim** in `ErrorState`; a `404` (IDOR or not-yet-shared) renders not-found, never a leak.
- **Uses `MaybeList<T> = { items, available }`** for any backend not yet wired: a `404`/`501` resolves to
  `{ items: [], available: false }` (the `isUnavailable`/`notBuilt` helper) so the panel shows a
  "connect …" `EmptyState` rather than an error — the shipped Templates/Drafts/Inbox behaviour.
- **Attaches an `Idempotency-Key`** (D5 — backed by the real `idempotency_keys` table) to every write
  that could fan out or charge (enroll-bulk, send, bulk-suppress) so a retried click never double-sends.
- **Reloads on mutation (no optimistic UI in MVP).** A mutation hook awaits the write, then calls
  `reload()`; it never patches local state ahead of the server. Each action carries its **own pending
  state** (the `EnrollmentPanel`/`SendStatusDashboard` pattern), so one row's "Send next step" spinner
  never blocks the table.

> **Large-data handling (canon, mandatory).** Two tables are unbounded and must **virtualize +
> cursor-paginate** (keyset, never offset, never load-all): **Send history** (Analytics, §7, fed by
> `activities` + the partitioned raw `email_event` store) and the **Suppression list** (§8, the
> `suppression_list` table) — each can reach 10k–1M rows per workspace via the `@leadwolf/ui` `DataTable`
> virtualization. The **Unified Inbox** thread list (§5) is likewise cursor-paginated infinite scroll.
> Everything else (templates, sequences, mailboxes) is small and renders a plain list with a "Load more"
> only if a workspace exceeds the first page.

---

## 3. Templates tab — wire the stub into a reusable-content library (P2)

**Lives under:** `Sequences` destination → **Templates** tab (`/sequences?view=templates`).
**Status today:** `TemplatesPanel.tsx` is a **stub** — `fetchTemplates()` returns
`{ items: [], available: false }` (the `/api/v1/templates` backend answers `404`/`501`), and the panel
shows a "connect …" `EmptyState`. **The P2 work is: wire the backend + build the editor.**
**Deep doc:** templating, merge-field grammar, and version semantics → `01-templating.md`.

Best-in-class tools treat templates as a **searchable library of reusable blocks with personalization
tokens and fallbacks**: HubSpot's snippet/template model inserts reusable text blocks and personalization
tokens (with a **fallback value** when a contact field is empty), and Apollo manages personalization
tokens inside sequence emails the same way — a dynamic variable replaced with CRM data at send time, with
a default for missing values.[^hubspot-templates][^apollo-tokens] Our Templates tab follows that pattern;
the **merge-field grammar and fallback rules are owned by `01`**, this tab is the library + editor shell.
The shipped `MERGE_FIELDS` list in `features/sequences/types.ts` (`{{first_name}}`, `{{company}}`,
`{{sender_name}}`, …) is the seed; `01` owns the full grammar.

### 3.1 Purpose & key elements
- **Purpose:** create, organise, and reuse template content (subject + body) with merge fields, so reps
  and sequence steps send consistent, personalized copy. A template's id is handed to a step via the
  existing `NewStepInput.template_id` field (shipped in `features/sequences/types.ts`). The tab owns the
  **library and editor shell**; rendering/merge rules are `01`.
- **Key elements:**
  - A **library list** (`DataTable` or card grid) of `TemplateSummary` rows (the shipped shape:
    `id`, `name`, `channel`, `subject`, `body`, `updatedAt`): name, folder/tag, owner, last-updated, and
    a **usage chip** (used in N sequences) and **reply-rate chip** (from `08`, reply primary — D6) so
    reps pick what works.
  - A **search + folder filter** and a **"Mine · Shared · All"** `SegmentedControl` (owner scope, D8).
  - A **`TemplateEditor` drawer** (§3.2): subject `TpInput`, body editor, a **merge-field picker**
    (insert `{{first_name}}`-style tokens with a **fallback** affordance, grammar per `01`), a **live
    preview** against a sample masked contact, and a **version history** panel (every save is a version;
    restore a prior one — the version store is `01`'s contract).
- **Primary actions:** New template · Edit · Duplicate · Move to folder · Archive/Delete (owner-gated,
  D8) · "Use in sequence" (hands the template id to the `SequenceBuilder`, §4.2).

### 3.2 The editor drawer (shell only)
The `TemplateEditor` is a focus-trapped `Drawer` (WCAG 2.2 AA): labelled fields via `FieldGroup`, the
merge-field picker keyboard-navigable, and a **preview/source toggle**. It saves a new version on each
commit and shows the version list with author + timestamp + restore. **The token grammar, validation, and
render output are `01`'s contract** — the editor only inserts and previews. A mutation **reloads** the
library (no optimistic insert), with the New/Save button carrying its own pending state.

### 3.3 Four states (StateSwitch)
| State | Render |
|---|---|
| **Loading** | `LoadingState` skeleton list (reduced-motion-safe). |
| **Not wired yet** | `MaybeList.available === false` → `EmptyState` *"Templates ship with the templating backend."* (the current stub behaviour, until P2 wires `/api/v1/templates`). |
| **Empty (no templates)** | `EmptyState`, icon `<FileText/>`: *"No templates yet."* + one primary action **New template**. |
| **Empty (search → none)** | lighter empty: *"No templates match '<query>'."* + "Clear search". |
| **Error** | `ErrorState` + `onRetry={reload}`. |
| **Data** | The library list / card grid. |

### 3.4 Owner-scoped visibility (D8)
A rep sees **their own** templates and any **explicitly shared** workspace templates; the
"Mine · Shared · All" control is a **filter, not a wall** — RLS already confines results to the caller's
`tenant_id`+`workspace_id`, and ownership/sharing is enforced server-side (`12`). Editing/deleting another
rep's template is owner-/role-gated server-side; the UI hides those affordances when not permitted.

---

## 4. Sequences tab + Mailboxes — wire real send into the built cadence, create the senders

### 4.1 / 4.2 Sequences tab (P4 — built; wire real email send)
**Lives under:** `Sequences` destination → **Sequences** tab (default, `/sequences`).
**Status today:** `SequenceList`, `SequenceBuilder`, `EnrollmentPanel`, `EnrollmentLogTable`, and
`SendStatusDashboard` are **fully built** against the real `/api/v1/outreach/*` API; sends go through the
shipped `sendStep.ts` with a **`consoleSender`** today. **The P4 work is: swap the `EmailSenderPort` to a
real provider/mailbox adapter (`02`/M12) — the send transaction itself does not change.**
**Deep doc:** sequence runtime, steps, scheduling, fan-out → `05-sequences-automation.md`.

Leading engagement platforms (Salesloft, Outreach) center on a **multi-step, multi-channel cadence
builder with conditional/behavior logic, send windows, and A/B testing**, paired with a **unified daily
task queue** that tells the rep the next best action; Salesloft is noted for a cleaner builder UI and
strong real-time analytics, Outreach for the most powerful sequencing and reporting.[^salesloft-outreach]
Our Sequences tab already follows that shape; the **scheduling/branching/fan-out runtime is `05`** and the
`outreach_log` enrollment table.

- **Purpose:** build and run **`outreach_sequences`** cadences — ordered **`outreach_steps`** with
  `delay_hours` and send windows — and enroll recipients into them (an **`outreach_log`** row per
  enrollment). The `outreach_steps.channel` field is **already** `email | linkedin` (the multi-channel
  hook; `05`/`07`).
- **Key elements (all shipped):** the **`SequenceList`** (`SequenceSummary`: name, `status`
  active/paused/archived, `enrolledCount`, and the **reply-rate** from `SequenceMetrics` as the headline
  metric — D6); the **`SequenceBuilder` drawer** (add/reorder steps via `POST /outreach/sequences/:id/steps`,
  per-step `template_id` + `delay_hours` + send window, A/B variant slot — *configured here, executed by
  `05`*); and the **`EnrollmentPanel`** (§4.3) feeding the **`EnrollmentLogTable`** and the
  **`SendStatusDashboard`** funnel.
- **Primary actions:** New sequence · Edit · Pause/Resume (`PATCH /outreach/sequences/:id`) · Duplicate ·
  Archive (owner-gated) · Enroll recipients.

### 4.3 Enrollment is suppression-gated + idempotent (D4, D5)
Enrolling recipients (a revealed contact, a Lists list, or a manual set) goes through the shipped
`enrollContact.ts` / `enroll-bulk` path: **revealed-only**, **`assertNotSuppressed` in-transaction (D4 —
the unbypassable gate, runs against `suppression_list`)**, and **idempotent** against
`UNIQUE(sequence_id, contact_id)` — the route returns **201 new / 200 already-enrolled**. Bulk enroll
**fans out** as a queued job; `EnrollmentPanel` shows queued → running (N of M) → done with the
server-returned count and a toast, an `Idempotency-Key` (D5, `idempotency_keys`) making a double-click
safe, and every enroll writes an `enroll` row to **`audit_log`**. Suppressed recipients are **skipped and
reported (403 "suppressed"), never silently sent to** — and the send tx (`sendStep.ts`) re-runs
`assertNotSuppressed` again at send time, so suppression overrides enrollment.

### 4.4 Mailboxes (P1 — the one NEW surface; the prerequisite for any real send)
**Lives under:** `Settings` → **Workspace** scope → **Mailboxes** (`/settings/mailboxes`).
**Status today:** **does not exist** — this is the only greenfield slice in this doc
(`features/settings-mailboxes`, §1.4) and the one navConfig entry to add (§1.2). It is the prerequisite
for swapping the `EmailSenderPort` from `consoleSender` to a real provider.
**Deep doc:** sending infra, providers (`mailbox_integration`), domains (`sending_domain`), warmup →
`02-sending-infrastructure.md`.

Best-in-class tools surface **per-mailbox health and warmup status** and pause a mailbox before it trips a
complaint/quota threshold (Smartlead tracks complaint rates in real time and pauses sending; the common
complaint about Instantly is precisely the *absence* of an early warning when a mailbox is flagged or hits
quota — so visible per-mailbox health is a differentiator).[^smartlead-instantly] Our Mailboxes page makes
mailbox health legible.

- **Purpose:** connect, monitor, and manage the **`mailbox_integration`** rows a workspace sends from —
  the encrypted ESP/OAuth credentials + provider that back the `EmailSenderPort` adapter (`02`/M12).
- **Key elements:** a list of connected mailboxes (address, provider Gmail/Outlook/SMTP, **health chip**
  healthy/warming/paused/error from `02`/`03`, daily send used/limit against the per-tenant send-quota
  built on the `creditRepository` `SELECT … FOR UPDATE` pattern, warmup status, last sync); a
  **"Connect a mailbox"** CTA launching the **OAuth flow** (`?connect=1` → `ConnectMailboxDialog`).
- **Primary actions:** Connect (OAuth) · Reconnect · Pause/Resume sending · Set daily limit · Disconnect.
- **Secrets stay server-side (D7, non-negotiable).** The connect flow is **OAuth only**; `useMailboxes`
  and the page **never display, accept, or store tokens/passwords/secrets** on the client — only
  connection *status* and *health*. (KMS encryption of `mailbox_integration` credentials is `02`/Security
  territory; the mandate stands.)

### 4.5 Four states — Sequences & Mailboxes (StateSwitch)
| Tab | Loading | Empty | Error | Data |
|---|---|---|---|---|
| **Sequences** | skeleton list | `<Send/>` *"No sequences yet."* + **New sequence** | `ErrorState`+retry | cadence list (the shipped `SequenceList`) |
| **Mailboxes** | skeleton list | `<Mail/>` *"Connect a mailbox to start sending."* + **Connect a mailbox** | `ErrorState`+retry | mailbox list w/ health chips |

### 4.6 Owner scope (D8)
Sequences default to **the signed-in rep's own** cadences (+ explicitly shared); managers see their team's
per `12`. Mailboxes are **workspace infrastructure** but a rep manages **their own** connected mailbox by
default; workspace-admins manage all (per `12`). Filters are convenience; RLS + ownership re-resolved
server-side are the wall.

---

## 5. Unified Inbox tab — wire mailbox sync + a reply composer (P3)

**Lives under:** `Inbox` destination → **Replies** tab (the unified email inbox); **Tasks** stays as the
second tab. **Status today:** `InboxPage` / `ThreadList` / `ThreadView` / `TasksPanel` are built as a
**contract** — `fetchThreads`/`fetchThread`/`updateThread`/`sendReply`/`fetchTasks` all treat a `404`/`501`
as `available: false` (no fabricated threads, no fake sends). **The P3 work is: wire mailbox sync (the
reply-ingestion pipeline) + the reply composer's real send.**
**Deep doc:** tracking + thread reconciliation → `04-status-event-tracking.md`.

The defining best-in-class pattern is a **unified inbox that consolidates all prospect communication
across mailboxes/channels into one place**, paired with a daily task/reply queue (Salesloft/Outreach both
center this).[^salesloft-outreach] Our Unified Inbox renders reconciled threads; the **reply-ingestion and
threading pipeline (mailbox sync → `activities` `email_replied` → thread reconciliation) is `04`**.

- **Purpose:** one place for a rep to read and reply to inbound email across all their connected
  `mailbox_integration`s, with each thread tied back via the shipped `InboxThread` shape
  (`contactId`, `sequenceId`/`sequenceName`, `channel email|linkedin`, `messages`, `assigneeId`).
- **Key elements:** a **three-pane layout** — a **cursor-paginated, virtualized `ThreadList`** (the
  shipped `InboxFilter` is `mine | unassigned | sequence`; search), a **`ThreadView` reading pane** (the
  reconciled thread: original send + reply, `InboxMessage` `direction inbound|outbound`), and a **reply
  composer** (insert a template §3, schedule, mark done). A reply can **pause the sender's enrollment**
  (reply detected → `outreach_log.status = 'replied'` → stop sequence, logic in `05`). Each thread shows
  the contact + sequence/step provenance.
- **Primary actions:** Reply (`sendReply`) · Reply with template · Mark done/unread/snooze
  (`updateThread`) · Snooze/Task it · Unenroll the contact · Open full record (hands to `RecordDetail`,
  reused — §5.3).

### 5.1 Inbox Tasks — the `source = "email"` / `"reply"` lane
The **Tasks** tab (`TasksPanel`, `fetchTasks`) already renders `InboxTask` rows whose **`source`** enum is
shipped as `manual | reply | follow_up | low_credits | import | dsar` (`features/inbox/types.ts`,
`TASK_SOURCE_LABEL`). Email wiring **feeds the `reply` (and follow-up) source**: when mailbox sync
reconciles an inbound reply (§5, `04`), the system creates a `reply`-sourced task ("Reply from <contact>")
so the rep's daily queue surfaces it. The UI **already labels** these (`TASK_SOURCE_LABEL.reply = "Reply"`);
no new task type is invented — the email subsystem only populates the existing `reply`/`follow_up` lanes
server-side.

### 5.2 Four states (StateSwitch)
| State | Render |
|---|---|
| **Loading** | skeleton thread-list + empty reading pane. |
| **Not wired yet** | `available === false` → `EmptyState` *"Inbox connects when mailbox sync is live."* (the current contract behaviour). |
| **Empty (no replies)** | `<Inbox/>` *"No replies yet. Replies to your sends land here."* |
| **Empty (filter → none)** | *"Nothing in 'Needs reply'."* + reset filter. |
| **Error** | `ErrorState` + retry on the thread list. |
| **Data** | thread list + reading pane + composer. |

### 5.3 Owner scope (D8 — strict here)
A rep sees **only their own** inbound threads by default (their sends' replies); this is the strictest
owner-scope tab because it is personal correspondence. Managers see their team's threads **only where `12`
grants it**; cross-rep visibility is never the default and never client-decided (the `InboxFilter` is a
filter, not an auth decision). Reply bodies are PII — masked where the role doesn't grant read, full only
where it does, enforced server-side.

---

## 6. Deliverability tab — wire the `DeliverabilitySection` placeholder (P5)

**Lives under:** `Reports` destination → **Sending & deliverability** section
(`features/reports/components/DeliverabilitySection.tsx`). **Status today:** a **placeholder** — `StatTile`
values are "—" and a "Connect sending" `EmptyState` explains the pipeline is post-MVP (no invented
numbers). **The P5 work is: wire the `sending_domain` auth, reputation, warmup, and bounce read models.**
**Deep doc:** SPF/DKIM/DMARC, bounce classes, reputation pools, warmup → `03-deliverability.md`.

Best-in-class cold-email tools centralise **domain authentication, blacklist/reputation monitoring,
inbox-placement, warmup status, and real-time complaint/bounce signals** in one deliverability dashboard,
and pause sending before a threshold trips (Smartlead's deliverability/health dashboard + blacklist
monitoring is the reference; Instantly bundles warmup + inbox-placement + blacklist monitoring into one
view).[^smartlead-instantly] Our Deliverability section visualizes those signals; the **computation is
`03`**.

- **Purpose:** show a rep/admin whether their **`sending_domain`s** and `mailbox_integration`s are healthy
  and landing in the inbox, and surface problems early (not "find out by checking manually").
- **Key elements:** **domain auth status** (SPF/DKIM/DMARC pass/fail per `sending_domain`, with the
  per-tenant **tracking CNAME** state — D3), **reputation pool** standing (per-tenant isolated — D2),
  **warmup curve/status**, **bounce-class breakdown** (hard/soft/block, fed by the shipped
  `handleBounce.ts` path that marks `outreach_log.status = 'bounced'` and inserts a workspace
  `suppression_list` row), **complaint rate**, and **blacklist/placement** indicators. Each problem has a
  plain-English "what to fix" note (the *fix instructions* are `03`'s content; this tab links to them).
- **Primary actions:** Verify domain (re-check DNS) · View setup instructions (→ `03`/Mailboxes) · Pause a
  mailbox/domain (→ Mailboxes §4.4).

### 6.1 Four states (StateSwitch)
| State | Render |
|---|---|
| **Loading** | skeleton cards for domains/mailboxes. |
| **Not wired yet** | the shipped placeholder: `<Send/>` *"Connect sending to see deliverability"* + "Connect sending" → Mailboxes. |
| **Empty (no domains)** | `<ShieldCheck/>` *"No sending domains yet. Connect a mailbox and add a domain to send."* + link to Mailboxes. |
| **Error** | `ErrorState` + retry. |
| **Data** | domain-auth cards + reputation/warmup/bounce panels. |

### 6.2 Owner scope (D8)
A rep sees the deliverability of **their own** mailboxes/domains; workspace-admins see all per `12`.
Reputation is **per-tenant isolated (D2)** — a rep never sees another tenant's signals, ever (RLS, `07`).

---

## 7. Analytics tab — wire the funnel; reply-rate primary, opens informational (P5) (D6)

**Lives under:** the **Reports** destination's funnel (`features/reports` `FunnelSection`) for the
cross-sequence view, plus the per-sequence **`SendStatusDashboard`** already built inside `/sequences`.
**Status today:** the per-sequence funnel renders from `SequenceMetrics` (the shipped
`{ sent, opened, clicked, replied, bounced }`); the cross-sequence Reports funnel needs the **send-metrics
read model wired** (fed from `activities` + the partitioned raw `email_event` store). **The P5 work is:
wire those reads — no new tables.**
**Deep doc:** metric definitions → `08-reporting-analytics.md`.

The industry has **shifted away from open rate as a primary KPI** because Apple Mail Privacy Protection
preloads images and marks messages "opened" regardless of a real view — as of early 2024 **>55% of global
opens came from Apple MPP devices**, inflating reported open rates by ~15–40%; sales leaders have moved
forecast/scoring models to **reply- and click-based metrics**.[^apple-mpp] This is **exactly locked
decision D6**, and the tab must enforce it (the shipped `SequenceMetrics` already carries `replied` as a
first-class count).

- **Purpose:** show whether email is working, with **reply rate as the headline metric** and the full
  funnel below; let a rep drill from a sequence into its send history.
- **Key elements:** a **funnel** — sent → delivered → **replied (primary)** → bounced / unsubscribed — per
  sequence/template/mailbox (the per-sequence `SendStatusDashboard` + the Reports `FunnelSection`); a
  **trend** over time; and a **virtualized, cursor-paginated Send history `DataTable`** (per-recipient
  rows from `activities`/`email_event`: recipient, sequence/step from `outreach_log`, status, sent-at,
  engagement summary) for drill-down.
- **The D6 rule (must render):** **opens are labelled "informational — inflated by Apple Mail Privacy, not
  a KPI"** (an inline `Tooltip`/note next to any open figure); **reply rate is the primary, default
  headline metric.** Opens may be shown but are visually subordinate and explicitly captioned; they are
  **never** the sort-default or the funnel's success metric.
- **Primary actions:** Filter (date / sequence / mailbox / template) · Export send history (masked,
  non-PII columns; role-gated server-side) · Open a recipient's record (→ `RecordDetail`).

### 7.1 Large-data handling
The **Send history table is the canonical large table** (10k–1M rows): **virtualized rows + keyset cursor
pagination** via `@leadwolf/ui` `DataTable` (never load-all, never offset). The funnel/trend are
server-aggregated reads (`08`, over `activities` + the partitioned `email_event` store), not client-computed
over raw rows.

### 7.2 Four states (StateSwitch)
| State | Render |
|---|---|
| **Loading** | skeleton funnel + skeleton table rows. |
| **Not wired yet** | the placeholder "Connect sending" empty (shared with §6 until the read model lands). |
| **Empty (no sends)** | `<BarChart2/>` *"No sends yet. Analytics appear once a sequence sends."* |
| **Empty (filter → none)** | *"No sends match these filters."* + reset. |
| **Error** | `ErrorState` + retry. |
| **Data** | funnel + trend + virtualized send-history table. |

### 7.3 Owner scope (D8)
A rep sees **their own** send analytics by default; managers see their team's roll-up per `12`. The funnel
and history are filtered to the caller's owned data server-side; "team/all" views appear only where the
role grants them. Per-tenant isolation (D2) is absolute.

---

## 8. Suppression surface — reuse the built compliance page as-is (P1+) (D4/D9)

**Lives under:** `Settings` → **Workspace** scope → **Suppression & DSAR** (`/settings/compliance`), the
**fully built** `features/settings-compliance` slice (`CompliancePage`, `SuppressionForm`,
`SuppressionList`, `DsarForm`). **Status today:** **shipped** — `addSuppression` / `listSuppressions` /
`removeSuppression` / `submitDsar` already call `/api/v1/compliance/*`. **There is no email-specific work
here beyond reuse:** suppression is the **`suppression_list`** table and `assertNotSuppressed` gate the
send tx already depends on. **Do not build a parallel `email_suppression` surface.**
**Deep doc:** consent, unsubscribe, legal enforcement → `06-compliance.md`.

- **Purpose:** view and manage the **`suppression_list`** entries (and **`consent_records`** state, D9)
  that **gate every send (D4)** — addresses/domains/contacts that must never be emailed (unsubscribed,
  hard-bounced via `handleBounce.ts`, complained, manually blocked). This is the customer-facing
  compliance surface.
- **Key elements:** a **virtualized, cursor-paginated `DataTable`** (the shipped `SuppressionList`) of
  entries (the real `SuppressionListItem` shape: `scope` global/tenant/workspace, `match_type`
  email/domain/phone/contact_id, **reason**, source, added-at, added-by — email/phone surface masked, by
  type only); a **search/filter by reason**; the **unsubscribe footer/link configuration** view (the
  token-based unsubscribe affordance `sendStep.ts` auto-appends, D9 — *rendered here, enforced by `06`*);
  and a clear statement that **suppression overrides everything** (a suppressed address is skipped even if
  enrolled, because the send tx re-runs `assertNotSuppressed`).
- **Primary actions:** Add suppression (single or **bulk import** — queued job for large lists, D10,
  `Idempotency-Key` → `idempotency_keys`) · Remove from suppression (danger-styled, confirm-required,
  audited as `suppression.remove` in `audit_log`) · Export (role-gated) · View unsubscribe link settings.

### 8.1 Four states (StateSwitch)
| State | Render |
|---|---|
| **Loading** | skeleton table rows. |
| **Empty (none suppressed)** | `<ShieldOff/>` *"No suppressed addresses. Unsubscribes and bounces are added here automatically."* |
| **Empty (filter → none)** | *"No entries match this reason."* + reset. |
| **Error** | `ErrorState` + retry. |
| **Data** | virtualized `suppression_list` table (`SuppressionList`). |

### 8.2 Owner scope (D8) — workspace-shared, mutation-gated
The suppression list is a **workspace-level compliance asset**: every member of the workspace **sees** it
(so no rep accidentally re-contacts a suppressed address), but **mutations are role-gated** — removing an
address is an admin/compliance-role action server-side (`12`/`06`), since un-suppressing is a compliance
decision. Adding is broadly allowed; **removing is gated and audited** (`suppression.remove` →
`audit_log`). RLS confines the list to the `tenant_id`/`workspace_id`; no cross-tenant visibility ever
(D2).

---

## 8b. Cross-surface wiring — RecordDetail timeline + enroll-from-List

Email is not only its own tabs — it **extends two surfaces reps already use daily**:

- **RecordDetail activity timeline (`features/prospect/components/RecordDetail.tsx`).** The contact drawer
  already renders an **`ActivityTimeline`** that reads `useActivities(contactId)` and maps
  `ACTIVITY_TYPE_LABELS[a.activityType]`. The **`activities` table already carries the email
  `activity_type` values** `email_sent | email_opened | email_clicked | email_replied` (channel `email`),
  so the email subsystem's only job here is to **populate those activity rows** (via the send tx, the
  tracking pipeline `04`, and the partitioned `email_event` roll-up) and **add the four labels** to
  `ACTIVITY_TYPE_LABELS`. The timeline component, its four states, and its `available:false` "Timeline not
  connected" empty are reused unchanged — opens stay informational here too (D6), and the timeline never
  renders raw secrets or unmasked bodies (server-masked).
- **Enroll-from-List (`features/lists` → Sequences).** A Lists list (or a multi-select in
  `features/prospect`) can hand its selection to the `EnrollmentPanel` (§4.3) — the same suppression-gated,
  revealed-only, idempotent `enroll-bulk` path. The list/selection ids from the client are **never trusted
  as a grant**: the API re-resolves every contact id under RLS + ownership and skips suppressed/unrevealed
  rows server-side. This reuses the shipped `AddToListDialog`/bulk-action seam rather than inventing an
  enroll surface in Lists.

These extensions add **no new tables and no new fetch pattern** — they populate `activities` and reuse the
`outreach_log` enroll path (D11).

---

## 9. The per-tab catalog (the contract table)

| Tab | Phase | Status today | Lives under | Purpose (real tables) | Key elements | Primary actions | Empty-state copy |
|---|---|---|---|---|---|---|---|
| **Templates** | P2 | Stub (`TemplatesPanel`, available:false) | Sequences → Templates | Reusable template content w/ merge fields (grammar→01) | Library list (usage + reply-rate chips), search/folders, `TemplateEditor` (merge picker, preview, versions) | New · Edit · Duplicate · Move · Archive · Use in sequence | "No templates yet." |
| **Sequences** | P4 | **Built**; swap `EmailSenderPort` to real | Sequences (default) | Build & run **`outreach_sequences`** / **`outreach_steps`** / **`outreach_log`** (runtime→05) | `SequenceList` (status, enrolled, **reply-rate**), `SequenceBuilder` (steps/delays/windows), `EnrollmentPanel` + `EnrollmentLogTable` + `SendStatusDashboard` | New · Edit · Pause/Resume · Duplicate · Archive · Enroll | "No sequences yet." |
| **Unified Inbox** | P3 | Contract (404/501) | Inbox → Replies | Inbound replies tied to sends via `outreach_log` (threading→04) | Virtualized `ThreadList`, `ThreadView` pane, reply composer (templates, schedule); Tasks `source=reply` lane | Reply · Reply w/ template · Mark done · Snooze/Task · Unenroll · Open record | "No replies yet. Replies to your sends land here." |
| **Mailboxes** | P1 | **NEW** (`features/settings-mailboxes`) | Settings → Workspace | Connect/monitor **`mailbox_integration`**s (infra→02) | Mailbox list (provider, **health chip**, send-quota limits, warmup), **OAuth connect** (D7) | Connect · Reconnect · Pause/Resume · Set limit · Disconnect | "Connect a mailbox to start sending." |
| **Deliverability** | P5 | Placeholder (`DeliverabilitySection`) | Reports → Sending & deliverability | Am I landing? **`sending_domain`** auth + reputation (mechanics→03) | Domain auth (SPF/DKIM/DMARC + tracking CNAME D3), reputation pool (D2), warmup, bounce/complaint (`handleBounce`), blacklist | Verify domain · View setup · Pause mailbox/domain | "Connect sending to see deliverability." |
| **Analytics** | P5 | Per-seq built; Reports funnel needs wiring | Reports funnel + `/sequences` `SendStatusDashboard` | Did it work? **Reply-rate primary; opens informational (D6)** — fed by `activities` + `email_event` (metrics→08) | Funnel (sent→delivered→**replied**→bounce/unsub), trend, **virtualized send-history table** | Filter · Export (masked, role-gated) · Open record | "No sends yet. Analytics appear once a sequence sends." |
| **Suppression** | P1+ | **Built — reuse as-is** | Settings → Workspace (Compliance) | The **`suppression_list`** that **gates every send (D4/D9)** (rules→06) | Virtualized `SuppressionList` (reason/source/added-by), unsubscribe-link config, `consent_records` | Add · Bulk import (queued) · Remove (gated, audited) · Export · View unsubscribe settings | "No suppressed addresses. Unsubscribes and bounces are added here automatically." |

---

## 10. Design-system contract (truepoint-design owns this; defers to Security on safety)

**Light theme only — no dark mode.** Every surface obeys the same rules (canon Design digest):

- **`@leadwolf/ui` components only; no new primitives.** `Tabs`, `PageHeader`, `DataTable`, `Drawer`,
  `Dialog`, `DropdownMenu`, `SegmentedControl`, `StatusBadge`, `StatTile`, `Progress`, `Tooltip`,
  `TpButton`, `TpInput`, `TpSelect`, `TpCheckbox`, `FieldGroup`, `Avatar`, `useToast`, and the **State
  Kit** (`StateSwitch` + `EmptyState`/`LoadingState`/`ErrorState`/`Skeleton`).
- **Vanilla-React data, not TanStack Query.** Every hook is `useState`/`useCallback` over `fetchWithAuth`,
  with a `MaybeList<T> = { items, available }` envelope for not-yet-wired backends and `StateSwitch` for
  the four states. **No query cache, no query keys, no `useQuery`** anywhere in the email surface.
- **Tokens only — `var(--tp-*)`.** Every color/space/radius/motion via tokens (`--tp-ink`, `--tp-ink-3`,
  `--tp-surface-*`, `--tp-space-*`, `--tp-radius-*`, `--tp-ease`) in each slice's `*.module.css` + inline
  token styles. **No raw hex, no ad-hoc px colors.**
- **Four states via `StateSwitch`, every async surface** (error → loading → empty → data), with the extra
  **"not wired yet"** state where `available === false` (Templates, Inbox, Deliverability) and two distinct
  empties (zero-data vs filtered-empty) per §3–§8. Skeletons are reduced-motion-safe.
- **Virtualize the big tables + cursor-paginate** (Send history §7 over `activities`/`email_event`,
  `suppression_list` §8, Inbox threads §5); never load-all, never offset (canon + §2).
- **WCAG 2.2 AA.** Focus-trapped/focus-restoring `Drawer`/`Dialog` (template editor, sequence builder,
  enroll, OAuth connect), labelled controls (`FieldGroup`/`aria-label`), keyboard-reachable danger actions
  (remove-suppression, disconnect, delete) all confirm-gated, `role="status"`/`aria-busy` on loading,
  `role="alert"` on errors, **color never the sole signal** (glyph + label + tone — health chips, bounce
  classes, status badges via the shipped `SEQUENCE_STATUS_TONE`/`ENROLLMENT_STATUS_TONE` maps).
- **Responsive** at 1280 / 768 / 375 (the inbox three-pane collapses to list→thread on narrow; tables
  switch to compact density; tabs stay reachable).
- **i18n.** All copy centralized in each slice's `types.ts` label maps (the shipped
  `SEQUENCE_STATUS_LABEL` / `ENROLLMENT_STATUS_LABEL` / `TASK_SOURCE_LABEL` pattern), translatable,
  surviving long strings and RTL; counts pluralized and `toLocaleString()`-formatted. Copy is **honest**
  about masking, queued/async jobs (D10), cost where metered (the per-tenant send-quota), **opens being
  informational (D6)**, and not-yet-wired backends (`available:false` → "not available yet").
- **Security has the final say on whether data is safe.** Client-side filters ("Mine/All", `InboxFilter`),
  client-side template preview, and any client masking are **UX, not boundaries**. PII (recipient
  addresses, reply bodies, revealed contacts) is masked/withheld **server-side** by default and shown only
  where the role grants it (`12`); secrets (`mailbox_integration` credentials) never touch the client
  (D7); IDOR → 404. Design defers to Security on all of it.

---

## 11. Owner-scoped visibility, summarized (D8 — non-negotiable; full matrix → 12)

D8: **every tab shows the signed-in user's own data by default**; more is granted only by role (`12`). The
pattern repeats across tabs and is always a **filter over an RLS+ownership wall**, never the wall:

| Tab | Default (a rep) | Broader (per `12`) | The wall |
|---|---|---|---|
| Templates | own + explicitly shared | team/all templates | RLS (`tenant_id`/`workspace_id`) + ownership/sharing server-side |
| Sequences | own cadences | team cadences (manager) | RLS + ownership (`outreach_sequences.created_by_user_id`) |
| Unified Inbox | **own threads only** (strictest) | team threads where granted | RLS + ownership; reply bodies PII-gated |
| Mailboxes | own connected mailbox(es) | all (workspace-admin) | RLS; **secrets server-side (D7)** |
| Deliverability | own mailboxes/domains | all (admin) | RLS; **per-tenant reputation isolation (D2)** |
| Analytics | own sends | team roll-up (manager) | RLS + ownership |
| Suppression | **see all** (workspace asset); **remove is gated** | admin/compliance removes | RLS (tenant/workspace); removals audited (`suppression.remove`) |

"Mine vs All/Team" controls are URL-param filters (shareable, never an auth decision). A rep can never see
another rep's threads/analytics by toggling a filter — the server returns only what their role permits, and
an out-of-scope id is a 404. **Security enforces; this surface renders.**

---

## 12. Cross-references (sibling docs)

- `00-overview.md` — D1–D11, vocabulary, canonical entities, doc index. **Read through the `14` name mapping.**
- `01-templating.md` — merge-field grammar, fallbacks, template version semantics. Templates tab consumes.
- `02-sending-infrastructure.md` — providers, **`mailbox_integration`**, **`sending_domain`**, OAuth, warmup, the `EmailSenderPort` adapter. Mailboxes page renders the connect/health surface.
- `03-deliverability.md` — SPF/DKIM/DMARC, bounce classes (`handleBounce`), reputation pools (D2), tracking CNAME (D3). Deliverability tab visualizes.
- `04-status-event-tracking.md` — the `activities` engagement timeline + the partitioned raw **`email_event`** store, thread reconciliation. Unified Inbox + Analytics + RecordDetail consume.
- `05-sequences-automation.md` — **`outreach_sequences`**/**`outreach_steps`**/**`outreach_log`** runtime, fan-out (D10). Sequences tab is the builder/enroll surface.
- `06-compliance.md` — **`suppression_list`**/**`consent_records`**, unsubscribe, D4/D9 enforcement (`assertNotSuppressed`). Suppression surface renders.
- `07-multitenancy-reputation-isolation.md` — RLS, per-tenant isolation (D2). The wall behind every tab; IDOR → 404.
- `08-reporting-analytics.md` — funnel/metric definitions, **opens informational not KPI (D6)**, reply-rate primary. Analytics tab renders.
- `09-data-model.md` — the real DTOs, reconciled to shipped names by `14`. This doc consumes; it does not define them.
- `11-admin-surface.md` — the `apps/admin` staff console (per-tenant reputation, break-glass via Users impersonation, ops). The internal counterpart to this customer surface.
- `12-roles-permissions.md` — the full who-sees-what matrix (`requireRole`/`requireOrgRole`/`platformAdmin`). This doc states the D8 default per tab and defers the matrix here.
- `13-rollout-phases.md` — the Phase Map (P1 Mailboxes + Suppression · P2 Templates · P3 Inbox · P4 Sequences send · P5 Deliverability + Analytics). This doc's tabs ship per those phases.
- `14-current-state-integration.md` — **ground truth.** What already ships (M9), the real table/code names, and **D11 (build on, don't duplicate)**. This doc's "Status today" and every real name are reconciled here.

---

[^hubspot-templates]: HubSpot — *Create and send templates* / *Add personalization tokens to a template or snippet* (reusable text blocks + personalization tokens with a fallback value when a contact field is empty). https://knowledge.hubspot.com/templates/create-and-send-templates · https://knowledge.hubspot.com/conversations/how-do-i-add-personalization-tokens-to-a-template-or-snippet
[^apollo-tokens]: Apollo — *How Do I Manage Personalization Tokens in Email Sequences?* (a personalization token is a dynamic variable replaced with CRM data at send, with a fallback default for missing values). https://www.apollo.io/insights/how-do-i-manage-personalization-tokens-in-email-sequences
[^salesloft-outreach]: HubSpot Blog — *Outreach vs. Salesloft* (unified inbox across channels, unified daily task queue, multi-step cadence builders with conditional logic + A/B testing; Salesloft's cleaner builder UI and real-time analytics, Outreach's deeper sequencing/reporting). https://blog.hubspot.com/sales/outreach-vs-salesloft
[^smartlead-instantly]: Smartlead vs Instantly comparisons (2025–2026) — deliverability/health dashboard, blacklist monitoring, real-time complaint tracking with auto-pause; Instantly bundling warmup + inbox-placement + blacklist monitoring; the criticism that a flagged/quota'd mailbox gives no early warning. https://sparkle.io/blog/smartlead-vs-instantly/ · https://www.saleshandy.com/blog/smartlead-vs-instantly/
[^apple-mpp]: Apple Mail Privacy Protection inflates open rates (preloads images, marks "opened" without a real view; >55% of global opens from Apple MPP devices in early 2024; open rates ~15–40% inflated; industry shift to reply/click-based metrics). https://postmarkapp.com/blog/how-apples-mail-privacy-changes-affect-email-open-tracking · https://instantly.ai/blog/email-open-tracking-how-it-works-accuracy-rates-and-why-your-open-metrics-may-be-wrong/
