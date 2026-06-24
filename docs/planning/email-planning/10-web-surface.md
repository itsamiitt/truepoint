# Email — The /web Customer Surface (10)

> Cites the **Locked Decisions (D1–D10)** and the **Shared Vocabulary / Canonical Entities** in
> `00-overview.md`, the **Phase Map** in `13-rollout-phases.md`, and the **roles matrix** in
> `12-roles-permissions.md`. This doc owns the **customer/staff-facing surface** of the email
> subsystem inside `apps/web` (the customer app): every tab/page the rep, manager, and
> workspace-admin touch, where the feature code lives, and how Email slots into the existing
> AppShell. It is **surface + composition**, not new subsystems — the engines (templating, sending,
> deliverability, tracking, sequences, suppression, analytics) are specified in their own deep docs
> and this doc only *consumes* their DTOs and *renders* their triggers/states.
>
> This document mirrors `docs/planning/list-plan/04-list-workspace-ui.md` in shape and tone:
> prescriptive, contract-like, reuse-over-rebuild, four-states-mandatory, owner-scoped-by-default.
>
> **Scope boundaries (read these first):**
> - **Templating / merge fields / versions** → `01-templating.md`. The Templates tab is the
>   *editor and library shell*; the merge-field grammar, version semantics, and rendering rules are `01`.
> - **Sending infra / mailbox connect / domains / warmup** → `02-sending-infrastructure.md`. The
>   Mailboxes tab renders the **OAuth connect flow and health chips** (D7); the provider math is `02`.
> - **Deliverability mechanics** (SPF/DKIM/DMARC, bounce classes, reputation pools, warmup curves) →
>   `03-deliverability.md`. The Deliverability tab *visualizes* those signals; it does not compute them.
> - **Tracking + inbox threading** (open/click/reply events, thread reconciliation) →
>   `04-status-event-tracking.md`. The Unified Inbox renders threads; the event pipeline is `04`.
> - **Sequence engine** (steps, scheduling, branching, enroll/fan-out) → `05-sequences-automation.md`.
>   The Sequences tab is the *builder and enrollment surface*; the runtime is `05`.
> - **Compliance / unsubscribe / consent** → `06-compliance.md`. The Suppression tab renders the
>   list and the unsubscribe affordance; the legal/enforcement rules are `06` (D4, D9).
> - **Analytics computation** → `08-reporting-analytics.md`. The Analytics tab renders funnels; the
>   metric definitions (esp. **opens are informational, not a KPI — D6**) are owned by `08`.
> - **Schema / DTOs** (`email_template`, `email_send`, `mailbox_integration`, … ) →
>   `09-data-model.md`. This doc consumes those DTOs; it does not define them.
> - **Roles / who-sees-what matrix** → `12-roles-permissions.md`. This doc states the owner-scope
>   *default* (D8) per tab and defers the full role matrix to `12`.
> - **Admin/staff console** (per-tenant reputation, break-glass, ops) → `11-admin-surface.md`. That
>   is `apps/admin`; this doc is the **customer** app `apps/web`.

---

## 1. Navigation & routing — slotting Email into the existing shell

### 1.1 The shell already owns Sequences and Inbox — Email **lands inside them**, it is not a 7th rail icon

`apps/web/src/components/shell/navConfig.ts` is **the single source of truth** for navigation — the
rail, the top-bar section title, the command palette, and the settings scope-nav all read it (its
header comment: "add a destination in exactly one place"). The current `DESTINATIONS` array is:
**Home · Prospect · Lists · Sequences · Inbox · Reports**, plus a pinned **Settings**.

Two of those are **already the email subsystem's natural homes**, and both ship today as stubs that
the email work *fills in* rather than replaces:

- **`Sequences`** (`/sequences`) already renders a `Tabs` switch — **Sequences · Templates · Send
  status** (`features/sequences/components/SequencesPage.tsx`). This is the existing stub destination
  the canon flags. The email subsystem **owns and deepens** these tabs.
- **`Inbox`** (`/inbox`) already renders **Replies · Tasks** (`features/inbox/components/InboxPage.tsx`).
  The email **Unified Inbox** *is* the Replies experience, deepened with thread reconciliation (`04`).

The decision (recorded here, final order is a `truepoint-design` call): **do not add a parallel
`/email` rail destination that competes with Sequences/Inbox.** A second top-level "Email" icon next
to "Sequences" and "Inbox" would split the rep's mental model across three doors for one workflow.
Instead the email subsystem maps onto the **existing rail destinations** plus **two settings-scope
pages**, organised as a coherent set of tabs:

| Subsystem tab | Rail destination it lives under | Route |
|---|---|---|
| **Templates** | Sequences | `/sequences` → Templates tab (`?view=templates`) |
| **Sequences** | Sequences | `/sequences` → Sequences tab (default) |
| **Unified Inbox** | Inbox | `/inbox` → Replies tab (the unified email inbox) |
| **Mailboxes** | Settings → Workspace | `/settings/mailboxes` |
| **Deliverability** | Sequences | `/sequences` → Deliverability tab (`?view=deliverability`) |
| **Analytics** | Sequences | `/sequences` → Analytics tab (`?view=analytics`); deep funnels link out to **Reports** (`/reports`) |
| **Suppression** | Settings → Workspace | `/settings/compliance` (the existing "Suppression & DSAR" scope page) |

> **Why Settings for Mailboxes + Suppression.** Both are **workspace-configuration** surfaces, not
> daily-work surfaces, and the shell's `SETTINGS_NAV` already reserves a **Workspace** scope with a
> "Suppression & DSAR" item (`/settings/compliance`). Mailboxes is connect-once / manage-rarely
> infrastructure that belongs beside other workspace config; Suppression is a compliance list that the
> spec already filed under Workspace. Putting them in Settings keeps the daily rail (Sequences/Inbox)
> about *doing* and Settings about *configuring* — the same split the app already uses for Auto-enrich,
> Custom fields, and Compliance.

This honours the canon's PHASE MAP precisely: **Mailboxes lands early (P1)** as a settings page since
sending needs a connected mailbox; **Suppression with compliance (P1+)** is the existing compliance
settings page; **Templates (P2)**, **Unified Inbox (P3)**, **Sequences (P4)**, **Deliverability +
Analytics (P5)** then fill the rail destinations tab-by-tab.

### 1.2 The three coordinated `navConfig.ts` edits (the only nav changes)

Because Sequences and Inbox are **already destinations**, the rail icons need no change. The required
edits are minimal and live **only** in `navConfig.ts`:

1. **`SETTINGS_NAV` → Workspace scope** — add the **Mailboxes** item (the Suppression item already
   exists as "Suppression & DSAR" → `/settings/compliance`):
   ```ts
   { label: "Mailboxes", href: "/settings/mailboxes", match: "/settings/mailboxes" }
   ```
   `sectionTitleFor("/settings/…")` already returns "Settings" for any settings path, so no title
   branch is needed.

2. **`PALETTE_QUICK`** — add keyboard-reachable quick actions for the email primary jobs (the rail
   destinations are already in `PALETTE_NAVIGATE` for free, since it is generated from `DESTINATIONS`):
   ```ts
   { id: "act-new-template",  label: "New email template", href: "/sequences?view=templates&new=1", keywords: ["email","template","snippet"] },
   { id: "act-new-sequence",  label: "New sequence",       href: "/sequences?new=1",                 keywords: ["cadence","outreach","email"] },
   { id: "act-connect-mailbox", label: "Connect a mailbox", href: "/settings/mailboxes?connect=1",   keywords: ["gmail","outlook","oauth","email","mailbox"] },
   ```
   The `?view=`, `?new=1`, `?connect=1` params are read on mount, open the right tab/dialog, then clear
   from the URL — mirroring how the Lists surface uses `?new=1`/`?import=1` (list-plan/04 §1.1).

3. **No `DESTINATIONS` edit.** Adding a destination here would be the regression: the rail, top bar,
   and palette already resolve Sequences/Inbox. Editing `Sidebar`/`AppShell`/`CommandPalette` directly
   is forbidden by the same rule (navConfig header comment).

### 1.3 Routes (App Router, under the `(shell)` group)

The `(shell)` route group wraps every signed-in destination in `AppShell` (rail + top bar + auth gate)
via `apps/web/src/app/(shell)/layout.tsx`. Email reuses the **existing** thin routes and adds **one
new settings route**. Every route file stays ~10 lines (import + `dynamic` + default export); all
behavior lives in the slice.

| Route file | Renders | Notes |
|---|---|---|
| `app/(shell)/sequences/page.tsx` (exists) | `<SequencesPage/>` from `@/features/email` (re-homed) | `force-dynamic` — reads `?view=`/`?new=1` from the URL (`useSearchParams`), same reason `prospect`/`lists` are force-dynamic. Hosts the **Sequences · Templates · Deliverability · Analytics** tabs (§3, §4, §6, §7). |
| `app/(shell)/inbox/page.tsx` (exists) | `<InboxPage/>` from `@/features/email` (Replies tab = unified inbox) | `force-dynamic` — thread cursor + filter read from URL. The **Unified Inbox** (§5). |
| `app/(shell)/settings/mailboxes/page.tsx` (**new**) | `<MailboxesPage/>` from `@/features/email` | `force-dynamic` — `?connect=1` opens the OAuth connect flow (§4). Lives in the Settings layout's Workspace scope. |
| `app/(shell)/settings/compliance/page.tsx` (exists) | compliance page hosting `<SuppressionPanel/>` | The **Suppression** tab (§8). The compliance page already exists for DSAR; Suppression is a section/tab within it. |

> **IDOR is a 404, not a leak (Security, final say).** Every email route reads IDs from the URL but
> **never trusts them as an access grant**. A `templateId`, `sequenceId`, `sendId`, or `mailboxId`
> that is not in the caller's `tenant_id`+`workspace_id` (and, where owner-scoped, not visible to the
> caller) resolves **404 server-side** below the app layer (RLS, `07-multitenancy-reputation-isolation.md`);
> the page renders `ErrorState`/not-found, never another tenant's or another rep's data (D8). The client
> tab/route is convenience; the wall is RLS + ownership in the API.

### 1.4 The feature slice — `apps/web/src/features/email/`

The email subsystem is **one feature slice** (the daily-work tabs that share data and chrome) plus the
two settings panels it exports. It mirrors the `features/prospect` / `features/lists` shape (canon
FILE-STRUCTURE REFERENCES) and **absorbs the existing `features/sequences` and `features/inbox`
stubs** rather than running three parallel slices. (Whether the inbox sub-tree physically stays under
`features/inbox` and re-exports through `features/email`, or is moved in, is a build-time
`truepoint-architecture` call; the **contract** is one coherent public barrel.)

```
apps/web/src/features/email/
  api.ts                      # typed fetchWithAuth wrappers for /api/v1/email/* (cursor, Idempotency-Key, RFC 9457 → ApiError); §2
  types.ts                    # presentation view-models + centralized copy/label maps (i18n-ready, §9); consumes @leadwolf/types DTOs type-only
  index.ts                    # public barrel: { SequencesPage, InboxPage, MailboxesPage, SuppressionPanel }
  email.module.css            # tokens-only styling (var(--tp-*))
  components/
    SequencesPage.tsx         # the Sequences destination: Tabs across Sequences · Templates · Deliverability · Analytics (§3,§4,§6,§7)
    TemplatesLibrary.tsx      # template list + folders + search (§3.1)
    TemplateEditor.tsx        # editor drawer: subject/body, merge-field picker, preview, version history (§3.2; grammar→01)
    SequenceList.tsx          # the cadence list (status, enrolled, reply-rate) (§4.1)
    SequenceBuilder.tsx       # step builder drawer: steps, delays, send windows (§4.2; runtime→05)
    EnrollmentPanel.tsx       # enroll selected/recipients → queued job + progress (D10) (§4.3)
    DeliverabilityPanel.tsx   # domain auth + reputation + warmup + bounce signals (§6; mechanics→03)
    AnalyticsPanel.tsx        # send funnel: sent→delivered→reply (reply primary, opens informational D6) (§7; metrics→08)
    InboxPage.tsx             # the Inbox destination: Replies (unified email inbox) · Tasks (§5)
    UnifiedInbox.tsx          # thread list + reading pane + reply composer (§5; threading→04)
    MailboxesPage.tsx         # connected mailboxes + OAuth connect + health chips (§4 / settings)
    SuppressionPanel.tsx      # suppression list + add/import/remove + unsubscribe view (§8; rules→06)
  hooks/
    useTemplates.ts           # library data + reload + optimistic CRUD
    useSequences.ts           # cadence list + status toggle (reused/absorbed from the stub)
    useSequenceBuilder.ts     # builder draft state
    useEnrollment.ts          # enroll mutation → job state + progress poll (D10)
    useInboxThreads.ts        # cursor-paginated threads + reply mutation
    useMailboxes.ts           # mailbox list + connect/disconnect; never reads secrets (D7)
    useDeliverability.ts      # domain/reputation/warmup read model
    useEmailAnalytics.ts      # cursor-paginated funnel + send history
    useSuppression.ts         # cursor-paginated suppression entries + add/remove
```

**Reused from sibling slices, not copied** (cross-slice via the public `index.ts` barrel, the allowed
seam — same `boundaries`-lint rule as list-plan/04 §1.3): the `DataTable`/`Column` machinery and bulk
selection from `features/prospect`/`features/lists` for the **Send history** and **Suppression** tables,
the masking helpers where recipient PII is shown, and `currentUserId` for the "mine vs all" owner gate
(§D8 across tabs). No new primitives — everything composes `@leadwolf/ui`.

---

## 2. The API seam — `api.ts` typed fetch wrappers (consume, don't define)

`email/api.ts` is a thin typed client over `/api/v1/email/*`, mirroring `prospect/api.ts`
(canon API constraints). It is the **only** place the slice talks to the network. It:

- Issues **cursor-paginated** reads (send history, analytics rows, inbox threads, suppression entries)
  — never offset; the UI carries `nextCursor` and renders "Load more" / virtualized infinite scroll
  (§ large-data note below). Request/response shapes are the **Zod schemas in `@leadwolf/types`**
  (imported type-only); `api.ts` validates nothing the server owns (client validation is UX, not a
  boundary — Security).
- Attaches an **`Idempotency-Key`** to every write that could fan out or charge (enroll, send-now,
  bulk-suppress) so a retried click never double-sends (D5). The key is generated client-side per
  user intent and surfaced to the user only as "queued".
- Maps **RFC 9457** problem responses to a typed `ApiError` (reusing the prospect slice's
  `ApiError`/`toApiError`/`notBuilt` pattern), so every tab's `ErrorState` shows a calm message and a
  retry — and a `404` (IDOR or not-yet-shared) renders not-found, never a leak.
- For **async / fan-out actions** (enroll, send, bulk-suppress) returns the **queued job state +
  progress handle** (D10); the calling hook polls/streams job status and the UI shows queued → running
  → done with a count, never a synchronous "done" lie.

> **Large-data handling (canon, mandatory).** Two tables are unbounded and must **virtualize +
> cursor-paginate**: **Send history** (Analytics, §7) and the **Suppression list** (§8) can each reach
> 10k–1M rows per workspace. They use the `@leadwolf/ui` `DataTable`'s virtualization with keyset
> cursors — never load-all, never offset paging. The **Unified Inbox** thread list (§5) is likewise
> cursor-paginated infinite scroll. Everything else (templates, sequences, mailboxes) is small and
> renders a plain list with a "Load more" only if a workspace exceeds the first page.

---

## 3. Templates tab — the reusable-content library (P2)

**Lives under:** `Sequences` destination → **Templates** tab (`/sequences?view=templates`).
**Deep doc:** templating, merge-field grammar, and version semantics → `01-templating.md`.

Best-in-class tools treat templates as a **searchable library of reusable blocks with personalization
tokens and fallbacks**: HubSpot's snippet/template model inserts reusable text blocks and
personalization tokens (with a **fallback value** when a contact field is empty), and Apollo manages
personalization tokens inside sequence emails the same way — a dynamic variable replaced with CRM data
at send time, with a default for missing values.[^hubspot-templates][^apollo-tokens] Our Templates tab
follows that pattern; the **merge-field grammar and fallback rules are owned by `01`**, this tab is the
library + editor shell.

### 3.1 Purpose & key elements
- **Purpose:** create, organise, and reuse `email_template` content (subject + body) with merge fields,
  so reps and sequences send consistent, personalized copy. The tab owns the **library and editor
  shell**; rendering/merge rules are `01`.
- **Key elements:**
  - A **library list** (`DataTable` or card grid) of `email_template` rows: name, folder/tag, owner,
    last-updated, and a **usage chip** (used in N sequences) and **reply-rate chip** (from `08`, reply
    primary — D6) so reps pick what works.
  - A **search + folder filter** and a **"Mine · Shared · All"** `SegmentedControl` (owner scope, §D8).
  - A **`TemplateEditor` drawer** (§3.2): subject `TpInput`, body editor, a **merge-field picker**
    (insert `{{first_name}}`-style tokens with a **fallback** affordance, grammar per `01`), a **live
    preview** against a sample contact, and a **version history** panel (`email_template_version` —
    every save is a version; restore a prior one).
- **Primary actions:** New template · Edit · Duplicate · Move to folder · Archive/Delete (owner-gated,
  §D8) · "Use in sequence" (hands the template id to the builder, §4.2).

### 3.2 The editor drawer (shell only)
The `TemplateEditor` is a focus-trapped `Drawer` (WCAG 2.2 AA): labelled fields via `FieldGroup`, the
merge-field picker keyboard-navigable, and a **preview/source toggle**. It saves a new
`email_template_version` on each commit and shows the version list with author + timestamp + restore.
**The token grammar, validation, and render output are `01`'s contract** — the editor only inserts and
previews.

### 3.3 Four states (StateSwitch)
| State | Render |
|---|---|
| **Loading** | `LoadingState` skeleton list (reduced-motion-safe). |
| **Empty (no templates)** | `EmptyState`, icon `<FileText/>`: *"No templates yet."* + one primary action **New template**. |
| **Empty (search → none)** | lighter empty: *"No templates match '<query>'."* + "Clear search". |
| **Error** | `ErrorState` + `onRetry={reload}`. |
| **Data** | The library list / card grid. |

### 3.4 Owner-scoped visibility (D8)
A rep sees **their own** templates and any **explicitly shared** workspace templates; the
"Mine · Shared · All" control is a **filter, not a wall** — RLS already confines results to the
caller's workspace, and ownership/sharing is enforced server-side (`12`). Editing/deleting another
rep's template is owner-/role-gated server-side; the UI hides those affordances when not permitted.

---

## 4. Sequences tab + Mailboxes — building the cadence and the senders

### 4.1 / 4.2 Sequences tab (P4)
**Lives under:** `Sequences` destination → **Sequences** tab (default, `/sequences`).
**Deep doc:** sequence runtime, steps, scheduling, fan-out → `05-sequences-automation.md`.

Leading engagement platforms (Salesloft, Outreach) center on a **multi-step, multi-channel cadence
builder with conditional/behavior logic, send windows, and A/B testing**, paired with a **unified daily
task queue** that tells the rep the next best action; Salesloft is noted for a cleaner builder UI and
strong real-time analytics, Outreach for the most powerful sequencing and reporting.[^salesloft-outreach]
Our Sequences tab follows that shape; the **scheduling/branching/fan-out runtime is `05`**.

- **Purpose:** build and run `email_sequence` cadences — ordered `email_sequence_step`s with delays
  and send windows — and enroll recipients into them.
- **Key elements:** the **`SequenceList`** (name, status active/paused/draft, enrolled count, and the
  **reply-rate** as the headline metric — D6); the **`SequenceBuilder` drawer** (add/reorder steps,
  per-step template + delay + send window, A/B variant slot — all *configured here, executed by `05`*);
  and the **`EnrollmentPanel`** (§4.3).
- **Primary actions:** New sequence · Edit · Pause/Resume · Duplicate · Archive (owner-gated) · Enroll
  recipients.

### 4.3 Enrollment is a queued job (D10)
Enrolling recipients (a revealed list selection, a Lists list, or a manual set) **fans out**, so the
action returns a **queued job state with progress** — never a synchronous "done". `EnrollmentPanel`
shows queued → running (N of M) → done with the **server-returned enrolled count** and a toast; an
`Idempotency-Key` (D5) makes a double-click safe. Every enroll is **suppression-gated server-side
(D4)** — recipients on the `email_suppression` list are skipped and reported, never silently sent to.

### 4.4 Mailboxes (P1 — lands early; the prerequisite for any send)
**Lives under:** `Settings` → **Workspace** scope → **Mailboxes** (`/settings/mailboxes`).
**Deep doc:** sending infra, providers, domains, warmup → `02-sending-infrastructure.md`.

Best-in-class tools surface **per-mailbox health and warmup status** and pause a mailbox before it
trips a complaint/quota threshold (Smartlead tracks complaint rates in real time and pauses sending;
the common complaint about Instantly is precisely the *absence* of an early warning when a mailbox is
flagged or hits quota — so visible per-mailbox health is a differentiator).[^smartlead-instantly] Our
Mailboxes page makes mailbox health legible.

- **Purpose:** connect, monitor, and manage the `mailbox_integration`s a workspace sends from.
- **Key elements:** a list of connected mailboxes (address, provider Gmail/Outlook/SMTP, **health
  chip** healthy/warming/paused/error from `02`/`03`, daily send used/limit, warmup status, last
  sync); a **"Connect a mailbox"** CTA launching the **OAuth flow** (`?connect=1`).
- **Primary actions:** Connect (OAuth) · Reconnect · Pause/Resume sending · Set daily limit ·
  Disconnect.
- **Secrets stay server-side (D7, non-negotiable).** The connect flow is **OAuth only**; the page
  **never displays, accepts, or stores tokens/passwords/secrets** on the client. It shows connection
  *status* and *health*, not credentials. (KMS is a known gap — the mandate stands; `02`/Security own it.)

### 4.5 Four states — Sequences & Mailboxes (StateSwitch)
| Tab | Loading | Empty | Error | Data |
|---|---|---|---|---|
| **Sequences** | skeleton list | `<Send/>` *"No sequences yet."* + **New sequence** | `ErrorState`+retry | cadence list |
| **Mailboxes** | skeleton list | `<Mail/>` *"Connect a mailbox to start sending."* + **Connect a mailbox** | `ErrorState`+retry | mailbox list w/ health chips |

### 4.6 Owner scope (D8)
Sequences default to **the signed-in rep's own** cadences (+ explicitly shared); managers see their
team's per `12`. Mailboxes are **workspace infrastructure** but a rep manages **their own** connected
mailbox by default; workspace-admins manage all (per `12`). Filters are convenience; RLS + ownership
are the wall.

---

## 5. Unified Inbox tab — replies in one place (P3)

**Lives under:** `Inbox` destination → **Replies** tab (the unified email inbox); Tasks stays as the
second tab. **Deep doc:** tracking + thread reconciliation → `04-status-event-tracking.md`.

The defining best-in-class pattern is a **unified inbox that consolidates all prospect communication
across mailboxes/channels into one place**, paired with a daily task/reply queue (Salesloft/Outreach
both center this).[^salesloft-outreach] Our Unified Inbox renders reconciled threads; the **event and
threading pipeline is `04`**.

- **Purpose:** one place for a rep to read and reply to inbound email across all their connected
  `mailbox_integration`s, with each message tied back to its `email_send`/`email_enrollment`/contact.
- **Key elements:** a **`UnifiedInbox`** three-pane layout — a **cursor-paginated, virtualized thread
  list** (filter: Unread · Needs reply · Mine; search), a **reading pane** (the reconciled thread with
  the original send and the reply), and a **reply composer** (insert a template §3, schedule, mark
  done). A reply can **pause the sender's enrollment** (e.g. "reply detected → stop sequence", logic
  in `05`). Each thread shows the contact + sequence/step provenance.
- **Primary actions:** Reply · Reply with template · Mark done/unread · Snooze/Task it · Unenroll the
  contact · Open full record (hands to `RecordDetail`, reused).

### 5.1 Four states (StateSwitch)
| State | Render |
|---|---|
| **Loading** | skeleton thread-list + empty reading pane. |
| **Empty (no replies)** | `<Inbox/>` *"No replies yet. Replies to your sends land here."* |
| **Empty (filter → none)** | *"Nothing in 'Needs reply'."* + reset filter. |
| **Error** | `ErrorState` + retry on the thread list. |
| **Data** | thread list + reading pane + composer. |

### 5.2 Owner scope (D8 — strict here)
A rep sees **only their own** inbound threads by default (their sends' replies); this is the strictest
owner-scope tab because it is personal correspondence. Managers see their team's threads **only where
`12` grants it**; cross-rep visibility is never the default and never client-decided. Reply bodies are
PII — masked where the role doesn't grant read, full only where it does, enforced server-side.

---

## 6. Deliverability tab — am I landing in the inbox? (P5)

**Lives under:** `Sequences` destination → **Deliverability** tab (`/sequences?view=deliverability`).
**Deep doc:** SPF/DKIM/DMARC, bounce classes, reputation pools, warmup → `03-deliverability.md`.

Best-in-class cold-email tools centralise **domain authentication, blacklist/reputation monitoring,
inbox-placement, warmup status, and real-time complaint/bounce signals** in one deliverability
dashboard, and pause sending before a threshold trips (Smartlead's deliverability/health dashboard +
blacklist monitoring is the reference; Instantly bundles warmup + inbox-placement + blacklist
monitoring into one view).[^smartlead-instantly] Our Deliverability tab visualizes those signals; the
**computation is `03`**.

- **Purpose:** show a rep/admin whether their `sending_domain`s and mailboxes are healthy and landing
  in the inbox, and surface problems early (not "find out by checking manually").
- **Key elements:** **domain auth status** (SPF/DKIM/DMARC pass/fail per `sending_domain`, with the
  custom **tracking domain** per tenant — D3), **reputation pool** standing (per-tenant isolated — D2),
  **warmup curve/status**, **bounce-class breakdown** (hard/soft/block from `03`), **complaint rate**,
  and **blacklist/placement** indicators. Each problem has a plain-English "what to fix" note (the
  *fix instructions* are `03`'s content; this tab links to them).
- **Primary actions:** Verify domain (re-check DNS) · View setup instructions (→ `03`/Mailboxes) ·
  Pause a mailbox/domain (→ Mailboxes §4.4).

### 6.1 Four states (StateSwitch)
| State | Render |
|---|---|
| **Loading** | skeleton cards for domains/mailboxes. |
| **Empty (no domains)** | `<ShieldCheck/>` *"No sending domains yet. Connect a mailbox and add a domain to send."* + link to Mailboxes. |
| **Error** | `ErrorState` + retry. |
| **Data** | domain-auth cards + reputation/warmup/bounce panels. |

### 6.2 Owner scope (D8)
A rep sees the deliverability of **their own** mailboxes/domains; workspace-admins see all per `12`.
Reputation is **per-tenant isolated (D2)** — a rep never sees another tenant's signals, ever (RLS).

---

## 7. Analytics tab — did it work? (reply-rate primary; opens informational) (P5)

**Lives under:** `Sequences` destination → **Analytics** tab (`/sequences?view=analytics`); deep
cross-sequence funnels link out to the **Reports** destination (`/reports`). **Deep doc:** metric
definitions → `08-reporting-analytics.md`.

The industry has **shifted away from open rate as a primary KPI** because Apple Mail Privacy Protection
preloads images and marks messages "opened" regardless of a real view — as of early 2024 **>55% of
global opens came from Apple MPP devices**, inflating reported open rates by ~15–40%; sales leaders
have moved forecast/scoring models to **reply- and click-based metrics**.[^apple-mpp] This is **exactly
locked decision D6**, and the tab must enforce it.

- **Purpose:** show whether email is working, with **reply rate as the headline metric** and the full
  funnel below; let a rep drill from a sequence into its send history.
- **Key elements:** a **funnel** — `email_send` sent → delivered → **replied (primary)** → bounced /
  unsubscribed — per sequence/template/mailbox; a **trend** over time; and a **virtualized,
  cursor-paginated Send history `DataTable`** (per-recipient `email_send` rows: recipient, sequence/step,
  status, sent-at, `email_tracking_event` summary) for drill-down.
- **The D6 rule (must render):** **opens are labelled "informational — inflated by Apple Mail Privacy,
  not a KPI"** (an inline `Tooltip`/note next to any open figure); **reply rate is the primary, default
  headline metric**. Opens may be shown but are visually subordinate and explicitly captioned; they are
  **never** the sort-default or the funnel's success metric.
- **Primary actions:** Filter (date / sequence / mailbox / template) · Export send history (masked,
  non-PII columns; role-gated server-side) · Open a recipient's record.

### 7.1 Large-data handling
The **Send history table is the canonical large table** (10k–1M rows): **virtualized rows + keyset
cursor pagination** via `@leadwolf/ui` `DataTable` (never load-all, never offset). The funnel/trend are
server-aggregated reads (`08`), not client-computed over raw rows.

### 7.2 Four states (StateSwitch)
| State | Render |
|---|---|
| **Loading** | skeleton funnel + skeleton table rows. |
| **Empty (no sends)** | `<BarChart2/>` *"No sends yet. Analytics appear once a sequence sends."* |
| **Empty (filter → none)** | *"No sends match these filters."* + reset. |
| **Error** | `ErrorState` + retry. |
| **Data** | funnel + trend + virtualized send-history table. |

### 7.3 Owner scope (D8)
A rep sees **their own** send analytics by default; managers see their team's roll-up per `12`. The
funnel and history are filtered to the caller's owned data server-side; "team/all" views appear only
where the role grants them. Per-tenant isolation (D2) is absolute.

---

## 8. Suppression tab — never email the wrong person (P1+, with compliance) (D4/D9)

**Lives under:** `Settings` → **Workspace** scope → **Suppression & DSAR** (`/settings/compliance`),
as the Suppression section/tab of the existing compliance page. **Deep doc:** consent, unsubscribe,
legal enforcement → `06-compliance.md`.

- **Purpose:** view and manage the `email_suppression` list (and `email_consent` state) that
  **gates every send (D4)** — addresses/domains that must never be emailed (unsubscribed, bounced,
  complained, manually blocked, do-not-contact). This is the customer-facing compliance surface (D9).
- **Key elements:** a **virtualized, cursor-paginated `DataTable`** of suppression entries (address or
  domain, **reason** unsubscribed/hard-bounce/complaint/manual, source, added-at, added-by); a
  **search/filter by reason**; the **unsubscribe footer/link configuration** view (the token-based
  unsubscribe affordance every send carries, D9 — *rendered here, enforced by `06`*); and a clear
  statement that **suppression overrides everything** (a suppressed address is skipped even if enrolled).
- **Primary actions:** Add suppression (single or **bulk import** — queued job for large lists, D10,
  `Idempotency-Key`) · Remove from suppression (danger-styled, confirm-required, audited) · Export
  (role-gated) · View unsubscribe link settings.

### 8.1 Four states (StateSwitch)
| State | Render |
|---|---|
| **Loading** | skeleton table rows. |
| **Empty (none suppressed)** | `<ShieldOff/>` *"No suppressed addresses. Unsubscribes and bounces are added here automatically."* |
| **Empty (filter → none)** | *"No entries match this reason."* + reset. |
| **Error** | `ErrorState` + retry. |
| **Data** | virtualized suppression table. |

### 8.2 Owner scope (D8) — workspace-shared, mutation-gated
The suppression list is a **workspace-level compliance asset**: every member of the workspace **sees**
it (so no rep accidentally re-contacts a suppressed address), but **mutations are role-gated** —
removing an address from suppression is an admin/compliance-role action server-side (`12`/`06`), since
un-suppressing is a compliance decision. Adding is broadly allowed; **removing is gated and audited**.
RLS confines the list to the tenant/workspace; no cross-tenant visibility ever (D2).

---

## 9. The per-tab catalog (the contract table)

| Tab | Phase | Lives under | Purpose | Key elements | Primary actions | Empty-state copy |
|---|---|---|---|---|---|---|
| **Templates** | P2 | Sequences → Templates | Reusable `email_template` content w/ merge fields (grammar→01) | Library list (usage + reply-rate chips), search/folders, `TemplateEditor` (merge picker, preview, version history) | New · Edit · Duplicate · Move · Archive · Use in sequence | "No templates yet." |
| **Sequences** | P4 | Sequences (default) | Build & run `email_sequence` cadences (runtime→05) | `SequenceList` (status, enrolled, **reply-rate**), `SequenceBuilder` (steps/delays/windows), `EnrollmentPanel` | New · Edit · Pause/Resume · Duplicate · Archive · Enroll | "No sequences yet." |
| **Unified Inbox** | P3 | Inbox → Replies | One place for inbound replies tied to sends (threading→04) | Virtualized thread list, reading pane, reply composer (templates, schedule) | Reply · Reply w/ template · Mark done · Snooze/Task · Unenroll · Open record | "No replies yet. Replies to your sends land here." |
| **Mailboxes** | P1 | Settings → Workspace | Connect/monitor `mailbox_integration`s (infra→02) | Mailbox list (provider, **health chip**, limits, warmup), **OAuth connect** (D7) | Connect · Reconnect · Pause/Resume · Set limit · Disconnect | "Connect a mailbox to start sending." |
| **Deliverability** | P5 | Sequences → Deliverability | Am I landing in the inbox? (mechanics→03) | Domain auth (SPF/DKIM/DMARC + tracking domain D3), reputation pool (D2), warmup, bounce/complaint, blacklist | Verify domain · View setup · Pause mailbox/domain | "No sending domains yet. Connect a mailbox and add a domain to send." |
| **Analytics** | P5 | Sequences → Analytics (→ Reports) | Did it work? **Reply-rate primary; opens informational (D6)** (metrics→08) | Funnel (sent→delivered→**replied**→bounce/unsub), trend, **virtualized send-history table** | Filter · Export (masked, role-gated) · Open record | "No sends yet. Analytics appear once a sequence sends." |
| **Suppression** | P1+ | Settings → Workspace (Compliance) | The list that **gates every send (D4/D9)** (rules→06) | Virtualized `email_suppression` table (reason/source/added-by), unsubscribe-link config, `email_consent` | Add · Bulk import (queued) · Remove (gated, audited) · Export · View unsubscribe settings | "No suppressed addresses. Unsubscribes and bounces are added here automatically." |

---

## 10. Design-system contract (truepoint-design owns this; defers to Security on safety)

**Light theme only — no dark mode.** All seven tabs obey the same rules (canon Design digest):

- **`@leadwolf/ui` components only; no new primitives.** `Tabs`, `PageHeader`, `DataTable`, `Drawer`,
  `Dialog`, `DropdownMenu`, `SegmentedControl`, `StatusBadge`, `Tooltip`, `TpButton`, `TpInput`,
  `TpSelect`, `TpCheckbox`, `FieldGroup`, `Avatar`, `useToast`, and the **State Kit** (`StateSwitch` +
  `EmptyState`/`LoadingState`/`ErrorState`/`Skeleton`).
- **Tokens only — `var(--tp-*)`.** Every color/space/radius/motion via tokens (`--tp-ink`, `--tp-ink-3`,
  `--tp-surface-*`, `--tp-space-*`, `--tp-radius-*`, `--tp-ease`) in `email.module.css` + inline token
  styles. **No raw hex, no ad-hoc px colors.**
- **Four states via `StateSwitch`, every async surface** (error → loading → empty → data), with two
  distinct empties (zero-data vs filtered-empty) per §3–§8. Skeletons are reduced-motion-safe.
- **Virtualize the big tables + cursor-paginate** (Send history §7, Suppression §8, Inbox threads §5);
  never load-all, never offset (canon + §2).
- **WCAG 2.2 AA.** Focus-trapped/focus-restoring `Drawer`/`Dialog` (template editor, sequence builder,
  enroll, connect), labelled controls (`FieldGroup`/`aria-label`), keyboard-reachable danger actions
  (remove-suppression, disconnect, delete) all confirm-gated, `role="status"`/`aria-busy` on loading,
  `role="alert"` on errors, **color never the sole signal** (glyph + label + tone — health chips,
  bounce classes, status badges).
- **Responsive** at 1280 / 768 / 375 (the inbox three-pane collapses to list→thread on narrow; tables
  switch to compact density; tabs stay reachable).
- **i18n.** All copy centralized in `email/types.ts` label maps (mirroring the prospect/lists slices),
  translatable, surviving long strings and RTL; counts pluralized and `toLocaleString()`-formatted.
  Copy is **honest** about masking, queued/async jobs (D10), cost where metered, **opens being
  informational (D6)**, and not-yet-built backends (`notBuilt` → "not available yet").
- **Security has the final say on whether data is safe.** Client-side filters ("Mine/All"),
  client-side template preview, and any client masking are **UX, not boundaries**. PII (recipient
  addresses, reply bodies, revealed contacts) is masked/withheld **server-side** by default and shown
  only where the role grants it (`12`); secrets never touch the client (D7); IDOR → 404. Design defers
  to Security on all of it.

---

## 11. Owner-scoped visibility, summarized (D8 — non-negotiable; full matrix → 12)

D8: **every tab shows the signed-in user's own data by default**; more is granted only by role (`12`).
The pattern repeats across tabs and is always a **filter over an RLS+ownership wall**, never the wall:

| Tab | Default (a rep) | Broader (per `12`) | The wall |
|---|---|---|---|
| Templates | own + explicitly shared | team/all templates | RLS (workspace) + ownership/sharing server-side |
| Sequences | own cadences | team cadences (manager) | RLS + ownership |
| Unified Inbox | **own threads only** (strictest) | team threads where granted | RLS + ownership; reply bodies PII-gated |
| Mailboxes | own connected mailbox(es) | all (workspace-admin) | RLS; **secrets server-side (D7)** |
| Deliverability | own mailboxes/domains | all (admin) | RLS; **per-tenant reputation isolation (D2)** |
| Analytics | own sends | team roll-up (manager) | RLS + ownership |
| Suppression | **see all** (workspace asset); **remove is gated** | admin/compliance removes | RLS (tenant/workspace); removals audited |

"Mine vs All/Team" controls are URL-param filters (shareable, never an auth decision). A rep can never
see another rep's threads/analytics by toggling a filter — the server returns only what their role
permits, and an out-of-scope id is a 404. **Security enforces; this surface renders.**

---

## 12. Cross-references (sibling docs)

- `00-overview.md` — D1–D10, vocabulary, canonical entities, doc index. **Canonical; this doc obeys it.**
- `01-templating.md` — merge-field grammar, fallbacks, `email_template_version` semantics. Templates tab consumes.
- `02-sending-infrastructure.md` — providers, `mailbox_integration`, `sending_domain`, OAuth, warmup. Mailboxes tab renders the connect/health surface.
- `03-deliverability.md` — SPF/DKIM/DMARC, bounce classes, reputation pools (D2), tracking domain (D3). Deliverability tab visualizes.
- `04-status-event-tracking.md` — `email_tracking_event`, thread reconciliation. Unified Inbox + Analytics consume.
- `05-sequences-automation.md` — `email_sequence`/`email_sequence_step`/`email_enrollment` runtime, fan-out (D10). Sequences tab is the builder/enroll surface.
- `06-compliance.md` — `email_suppression`/`email_consent`, unsubscribe, D4/D9 enforcement. Suppression tab renders.
- `07-multitenancy-reputation-isolation.md` — RLS, per-tenant isolation (D2). The wall behind every tab; IDOR → 404.
- `08-reporting-analytics.md` — funnel/metric definitions, **opens informational not KPI (D6)**, reply-rate primary. Analytics tab renders.
- `09-data-model.md` — all `email_*` DTOs. This doc consumes; it does not define them.
- `11-admin-surface.md` — the `apps/admin` staff console (per-tenant reputation, break-glass, ops). The internal counterpart to this customer surface.
- `12-roles-permissions.md` — the full who-sees-what matrix. This doc states the D8 default per tab and defers the matrix here.
- `13-rollout-phases.md` — the Phase Map (P1 Mailboxes + Suppression · P2 Templates · P3 Inbox · P4 Sequences · P5 Deliverability + Analytics). This doc's tabs ship per those phases.

---

[^hubspot-templates]: HubSpot — *Create and send templates* / *Add personalization tokens to a template or snippet* (reusable text blocks + personalization tokens with a fallback value when a contact field is empty). https://knowledge.hubspot.com/templates/create-and-send-templates · https://knowledge.hubspot.com/conversations/how-do-i-add-personalization-tokens-to-a-template-or-snippet
[^apollo-tokens]: Apollo — *How Do I Manage Personalization Tokens in Email Sequences?* (a personalization token is a dynamic variable replaced with CRM data at send, with a fallback default for missing values). https://www.apollo.io/insights/how-do-i-manage-personalization-tokens-in-email-sequences
[^salesloft-outreach]: HubSpot Blog — *Outreach vs. Salesloft* (unified inbox across channels, unified daily task queue, multi-step cadence builders with conditional logic + A/B testing; Salesloft's cleaner builder UI and real-time analytics, Outreach's deeper sequencing/reporting). https://blog.hubspot.com/sales/outreach-vs-salesloft
[^smartlead-instantly]: Smartlead vs Instantly comparisons (2025–2026) — deliverability/health dashboard, blacklist monitoring, real-time complaint tracking with auto-pause; Instantly bundling warmup + inbox-placement + blacklist monitoring; the criticism that a flagged/quota'd mailbox gives no early warning. https://sparkle.io/blog/smartlead-vs-instantly/ · https://www.saleshandy.com/blog/smartlead-vs-instantly/
[^apple-mpp]: Apple Mail Privacy Protection inflates open rates (preloads images, marks "opened" without a real view; >55% of global opens from Apple MPP devices in early 2024; open rates ~15–40% inflated; industry shift to reply/click-based metrics). https://postmarkapp.com/blog/how-apples-mail-privacy-changes-affect-email-open-tracking · https://instantly.ai/blog/email-open-tracking-how-it-works-accuracy-rates-and-why-your-open-metrics-may-be-wrong/
