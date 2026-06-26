# Email Subsystem — Current-State Ground Truth & M9→M12 Integration (14)

> **Status:** Ground truth (describes what is **already shipped**, not a plan). **Owner:** Platform +
> Data. **Last updated:** 2026-06-24.
> This is the **reconciliation / ground-truth** document for the `docs/planning/email-planning/` set. It
> is **authoritative on what exists in the codebase today** and on the rule that the email subsystem
> **extends the shipped M9 outreach engine** rather than building a parallel one. Where any sibling doc
> (`00`–`13`, `15`) names an entity, a code path, or a surface, **this doc is the source of truth for the
> real name** — siblings that still carry the old `email_*` working names are reconciled here in §2 and
> must be read through that mapping.
>
> **The one rule this doc enforces (Locked Decision D11, stated in full in §6):** the email subsystem
> **builds on, does not duplicate**, the M9 send engine. There is **no** new `email_sequence`,
> `email_sequence_step`, `email_enrollment`, `email_suppression`, `email_consent`, or
> `email_idempotency_key` table — those concepts are **already** `outreach_sequences`, `outreach_steps`,
> `outreach_log`, `suppression_list`, `consent_records`, and `idempotency_keys`. This is **milestone M12
> (extend M9)**, not a greenfield build (§5).
>
> **Convention (matches the list-plan set and the siblings here):** plain English + real table/file/column
> names; no migrations or TypeScript; cross-refs by doc number. Every path cited below is a real path in
> the repo as of this date.

---

## 1. What already exists — the shipped M9 outreach engine

The premise that "there is no email subsystem today" (still stated in `00 §1`, `00 §5`, `09 §1`) is
**incorrect and is corrected here.** TruePoint already ships a **suppression-gated outreach send engine**
— milestone **M9**, governed by **ADR-0009** (outreach engine), **ADR-0013** (credit-back),
**ADR-0004** (credit idempotency), and **ADR-0007** (per-workspace credit counter). The email plan set is
the work of **maturing that engine into a real, multi-mailbox, deliverability-managed email product** — it
is not a first build. Everything below is in `main` today.

### 1.1 The schema (real tables — `packages/db/src/schema/`)

| File | Tables (real, shipped) | What they already are |
|---|---|---|
| `outreach.ts` | **`outreach_sequences`** (`id`, `tenant_id`, `workspace_id`, `name`, `status` [`active`\|`paused`\|`archived`], `from_address`, `physical_address` [CAN-SPAM], `created_by_user_id`, `created_at`, `updated_at`; `UNIQUE(workspace_id, name)`) | The **Sequence/Cadence** entity (`00 §4`). Already carries the CAN-SPAM `from_address` + `physical_address` the send tx enforces (§1.2). |
| | **`outreach_steps`** (`id`, `tenant_id`, `workspace_id`, `sequence_id`, `step_order`, **`channel`** [`email`\|`linkedin`], `delay_hours`, `subject`, `body`, `created_at`; `UNIQUE(sequence_id, step_order)`) | The **Step** entity. `channel` is **already multi-channel** (`email`\|`linkedin`) — the extensibility hook for `05`/`07` (§6). |
| | **`outreach_log`** (`id`, `tenant_id`, `workspace_id`, `sequence_id`, `contact_id`, `status` [`enrolled`\|`active`\|`replied`\|`completed`\|`unsubscribed`\|`bounced`], `current_step`, `last_event_at`, `created_at`; `UNIQUE(sequence_id, contact_id)`) | The **Enrollment** entity. The `UNIQUE(sequence_id, contact_id)` constraint **is** enrollment idempotency. |
| `billing.ts` | **`suppression_list`** (`scope` [`global`\|`tenant`\|`workspace`], `tenant_id`, `workspace_id`, `match_type` [`email`\|`domain`\|`phone`\|`contact_id`], `email_blind_index`, `domain` [`citext`], `phone_blind_index`, `contact_id`, `reason`, `created_by_user_id`, `created_at`) | The **Suppression** entity and the **D4** gate's backing store. Already scoped global/tenant/workspace and blind-indexed. |
| | **`idempotency_keys`** (`tenant_id`, `key`, `response_status`, `response_body`; `UNIQUE(tenant_id, key)`) | The **D5** idempotency store. |
| | **`audit_log`** (`action` [closed enum incl. `send`\|`enroll`\|`unsubscribe`\|`suppression.add`\|`suppression.remove`\|`credit.adjust`\|`reveal.blocked`], `entity_type`, `entity_id`, `metadata` jsonb) | The append-only audit (IDs + actions, **no PII/bodies**). The `send`/`enroll`/`unsubscribe`/`suppression.*` actions are **already in the enum**. |
| `compliance.ts` | **`consent_records`** (`tenant_id`, `workspace_id`, `contact_id`, `jurisdiction` [ISO2], `lawful_basis` [`legitimate_interest`\|`consent`\|`contract`\|`public_record`], `source`, `valid_from`, `valid_until`, `withdrawn_at`, `recorded_by_user_id`); **`dsar_requests`** | The **Consent** entity (**D9**) and the DSAR intake. |
| `activity.ts` | **`activities`** (`tenant_id`, `workspace_id`, `contact_id`, `activity_type` [incl. `email_sent`\|`email_opened`\|`email_clicked`\|`email_replied`], `channel` [`email`\|`phone`\|`linkedin`\|`sales_navigator`\|`in-person`], `outcome`, `metadata` jsonb, `occurred_at`) | The **engagement timeline**. The email `activity_type` values **already exist** — this is the per-contact tracking surface `04`/`08` read. |
| `contacts.ts` | **`contacts`** (incl. `outreach_status` [`new`\|`in_sequence`\|`replied`\|`meeting_booked`\|`disqualified`\|`nurture`\|`unsubscribed`], `last_activity_at`, `email_enc`, `email_blind_index`, `email_domain`, `deleted_at`); `accounts`; `source_imports` | The Person, already with an **`outreach_status`** lifecycle and encrypted/blind-indexed email. |
| `auth.ts` | `tenants` (incl. **`reveal_credit_balance`**), `users`, `tenant_members`, `platform_staff`, `workspaces` | Tenancy + the credit balance the per-tenant **send-quota** will mirror (§6). |
| `webhooks.ts` | **`webhooks`** (external subscriber registrations) | The existing outbound **event-bus registry** — reuse for an `email.*` event stream (`04`, §6). |

### 1.2 The core domain logic (real, shipped — `packages/core/src/`)

This is the part the plan most often forgets exists. **The send transaction is already written, audited,
and CAN-SPAM-gated.** The M12 work swaps the *sender*, not the *transaction*.

- **`outreach/createSequence.ts`** — creates an `outreach_sequences` row (the Sequence create path).
- **`outreach/enrollContact.ts`** — enrolls a **revealed-only** contact: runs `assertNotSuppressed`
  **inside the transaction**, is **idempotent** against `UNIQUE(sequence_id, contact_id)`, and writes an
  `enroll` audit row. This is the real Enrollment path (`05`).
- **`outreach/sendStep.ts`** — **THE send transaction.** It **blocks the send unless** `from_address` +
  `physical_address` are present (**CAN-SPAM**, `06`), **re-runs `assertNotSuppressed` in-tx** (the
  fail-closed **D4** dequeue-time check), **auto-appends the postal + unsubscribe footer**, sends via the
  **injected `EmailSenderPort`**, advances `outreach_log`, and writes a `send` audit row. **This tx is the
  spine of `02` — it already exists.**
- **`outreach/handleBounce.ts`** — idempotent bounce handling: marks the `outreach_log` row `bounced`,
  **inserts a workspace `suppression_list` row**, and runs the **ADR-0013 credit-back**. This is the real
  bounce → suppression → credit-back loop (`03`, `04`).
- **`outreach/senderPort.ts`** — defines **`EmailSenderPort { send(OutboundEmail) -> { messageId } }`**.
  Today the bound implementation is a **`consoleSender`**. **M12's real SES/mailbox adapter swaps this port
  without touching `sendStep.ts`.** This is the single seam between the engine and `02`'s sending
  infrastructure.
- **`compliance/assertNotSuppressed.ts`** — **the unbypassable gate**, run in **both** the reveal tx and
  the send tx. This is **D4** in code (`06`).
- **`compliance/writeAudit.ts`** — transactional append-only audit (`12`).
- **`billing/` + `packages/db/src/repositories/creditRepository.ts`** — `lockBalance` via
  `SELECT … FOR UPDATE`; decrement-under-lock with a `CHECK` no-overdraft constraint; `grantFromEvent`
  idempotent. **This is the template for the NEW per-tenant send-quota** (§6) — the quota does not invent a
  locking pattern, it copies this one.

Supporting repositories already exist: `packages/db/src/repositories/outreachLogRepository.ts`,
`suppressionRepository.ts`, `creditRepository.ts`.

### 1.3 The API & workers (real, shipped)

- **`apps/api/src/features/outreach/routes.ts`** — mounted at **`/api/v1/outreach`**:
  `GET`/`POST /sequences`, `POST /sequences/:id/steps`, `POST /sequences/:id/enroll`
  (**201 newly enrolled / 200 already-enrolled**), `POST /sequences/:id/enroll-bulk`,
  `GET /sequences/:id/log`, `POST /log/:id/send` (dev `consoleSender`), `POST /log/:id/bounce`.
- **`apps/api/src/features/admin/`** — the **platformAdmin** routes (`routes.ts`, `auditLog.ts`,
  `impersonation.ts`, `providerConfigs.ts`, `staff.ts`) backing the shipped admin console (§1.5).
- **`apps/workers/src/queues/outreach.ts`** — `processOutreach` → `sendStep`. The tick/fan-out worker is
  here today; `05`/`02`'s named queues extend this file, they don't replace it. `dsar.ts` is the DSAR
  worker.

### 1.4 The customer frontend (real — `apps/web/src/`)

The `/sequences` surface is **fully built** today; `/inbox` and the Reports deliverability tab are
**defined-but-stubbed** (intentional `MaybeList available:false` seams, not missing code).

| Surface | State today | Real components / seams |
|---|---|---|
| **`/sequences`** | **Fully built** | `features/sequences/` — `SequenceList`, `SequenceBuilder`, `EnrollmentPanel`, `EnrollmentLogTable`, `SendStatusDashboard`, metrics funnel. **Templates panel STUB** (`fetchTemplates` → `MaybeList available:false`; `TemplateSummary { id, name, channel, subject, body, updatedAt }`). **AI `DraftReviewPanel` STUB**. (`api.ts` already targets `/api/v1/outreach` and `/api/v1/templates`.) |
| **`/inbox`** | **Contracts defined, backend 404/501** | `InboxThread { channel email\|linkedin, messages, assignee, sequenceId }`, `InboxTask { source … }`; `fetchThreads` / `sendReply` / `fetchTasks` (`04`, `10`). |
| **`/reports`** | **Built; deliverability tab is a placeholder** | Six dashboards; the **"Sending & deliverability"** tab is a placeholder — `StatTiles` show "—" and `DeliverabilitySection` renders an `EmptyState` "Connect sending" (`08`). |
| **`/settings/compliance`** | **Fully built** | `SuppressionForm`, `SuppressionList`, `DsarForm`; `addSuppression` / `listSuppressions` / `removeSuppression` / `submitDsar` — this **is** the **D4/D9** surface (`06`, `11`). |
| **`/settings/mailboxes`** | **Does not exist** | No feature folder yet — this is genuinely new M12 work (`02`), and the nav entry must be added (§4). |

### 1.5 The internal admin console (real, **fully built** — `apps/admin/src/`)

Not a stub. The admin app already ships the seven consoles below, all on the same `fetchWithAuth` +
`StateSwitch` + `DataTable` pattern, backed by `apps/api/src/features/admin/`:

| Console | Route | What it already does / its M12 role |
|---|---|---|
| **Tenants** | `/tenants` | Cross-tenant directory + detail (plan/status/seats/credits) — the home for per-tenant email limits/reputation (`11`). |
| **Users** | `/users` | Directory **+ impersonation**, role-gated. This **is** break-glass (time-boxed, audited) — `12`. |
| **Providers** | `/provider-configs` | ESP/SMS/enrichment **provider config** — the home for the pluggable **`ProviderAdapter`** registry the `EmailSenderPort` resolves against (§6, `02`). |
| **Feature flags** | `/feature-flags` | Global + per-tenant overrides — the home for **`email.*` staged rollout** (`13`). |
| **Staff** | `/staff` | Platform-staff management (`12`). |
| **Audit log** | `/audit-log` | The `audit_log` viewer (`12`). |
| **System health** | `/system-health` | Infra health, API latency, **queue depth**, error rates — the home for **email queue / ingestion SLOs** (`02`, operations). |

---

## 2. Entity reconciliation — the vocabulary correction (authoritative)

Every place a sibling doc (`00`–`13`) writes a `email_*` working name, it means the **real shipped table**
in the right-hand columns. **The real names are the source of truth.** A reviewer who finds a *new*
`email_sequence` / `email_sequence_step` / `email_enrollment` / `email_suppression` / `email_consent` /
`email_idempotency_key` table in any plan should treat it as a **bug against D11** (§6) and map it back
here.

| Former working name (`00 §4`, `09`) | Real shipped name | Where it lives | Verdict |
|---|---|---|---|
| `email_sequence` | **`outreach_sequences`** | `packages/db/src/schema/outreach.ts` | **REUSE** — same entity; do not create a parallel table. |
| `email_sequence_step` | **`outreach_steps`** | `outreach.ts` | **REUSE** — already multi-channel via `channel`. |
| `email_enrollment` | **`outreach_log`** | `outreach.ts` | **REUSE** — `UNIQUE(sequence_id, contact_id)` is the enrollment idempotency. |
| `email_tracking_event` (engagement timeline) | **`activities`** (+ a NEW raw `email_event` store for volume) | `activity.ts` (+ new) | **REUSE `activities` + NEW `email_event`** — `email_event` is a high-volume **partitioned** raw store that **feeds** `activities`; it does not replace it. |
| `email_suppression` | **`suppression_list`** | `billing.ts` | **REUSE** — already scope-aware (global/tenant/workspace) + blind-indexed. |
| `email_consent` | **`consent_records`** | `compliance.ts` | **REUSE** — already jurisdiction + lawful-basis. |
| `email_idempotency_key` | **`idempotency_keys`** | `billing.ts` | **REUSE** — the **D5** store. |
| `email_template` / `email_template_version` | (today) `outreach_steps.subject`/`body` inline; the Templates **panel STUB** (`TemplateSummary`) | `outreach.ts` / `features/sequences/` | **EXTEND** — a versioned `email_template` is genuinely new (`01`), but it **slots into the existing step model and the shipped Templates STUB**, it is not a fresh subsystem. |
| `email_send` | The **`outreach_log` row + the `sendStep.ts` tx**; the immutable transmitted artifact | `outreach.ts` / `core/outreach/sendStep.ts` | **EXTEND** — the enrollment/send state already lives on `outreach_log`; if a per-message immutable record is needed it is added **around** the existing send tx (`02`, `09`). |
| `mailbox_integration` (Sender) | **`EmailSenderPort` seam today**; `mailbox_integration` table is NEW | `core/outreach/senderPort.ts` (+ new table) | **NEW table, REUSE seam** — the port exists; M12 adds the encrypted credential table + provider behind it (`02`). |
| `sending_domain` | — | (new) | **NEW** — DKIM/SPF/DMARC + per-tenant tracking CNAME state (`03`, `07`). |
| Send-quota counter | **`creditRepository` FOR UPDATE pattern** | `repositories/creditRepository.ts` (+ new counter) | **NEW counter, REUSE pattern** — copies the locking discipline, does not reinvent it (§6). |
| Send transaction | **`core/outreach/sendStep.ts`** | `core/outreach/` | **REUSE** — do not write a second send path. |
| Bounce handling | **`core/outreach/handleBounce.ts`** | `core/outreach/` | **REUSE.** |

### 2.1 The genuinely new build (everything else is reuse/extend)

Per D11 (§6), the **only** net-new persistence/infrastructure M12 introduces is:

1. **`sending_domain`** — DKIM/SPF/DMARC verification state + the **per-tenant tracking CNAME** state
   (**D2**, **D3**; `03`, `07`).
2. **`mailbox_integration`** — **encrypted** ESP/OAuth credentials + provider (**D7**; `02`), bound behind
   the existing `EmailSenderPort`.
3. **`email_event`** — a **high-volume, range-partitioned raw tracking-event store** that **feeds**
   `activities` (`04`); it is the only place we accept the volume `activities` should not carry directly.
4. **The per-tenant send-quota counter** — built on the **`creditRepository` `SELECT … FOR UPDATE`**
   pattern (§6).
5. **Warmup + reputation pools** — pacing/state on top of `sending_domain` + `mailbox_integration`
   (`03`, `07`).

Everything else named in `00 §4` / `09` is a **rename** to a table that already ships.

---

## 3. The corrected frontend data pattern (vanilla React — **not** TanStack Query)

Any sibling doc (notably `10`) that describes `useQuery`, query keys, or a TanStack/React-Query cache is
**wrong about the codebase** and is corrected here. **TruePoint's web data pattern is vanilla React**, and
the shipped `features/sequences/` slice is the reference implementation any email surface must mirror.

The real pattern, verbatim from `apps/web/src/features/sequences/`:

- **Vanilla React state** — `useState` / `useCallback`; **no query cache, no `useQuery`, no query keys.**
- **`fetchWithAuth`** (`apps/web/src/lib/authClient.ts`, **ADR-0016**) — reads the in-memory access token;
  the slice's **only** seam to the backend (`features/sequences/api.ts`). It never touches the DB or the
  auth origin directly.
- **`MaybeList<T> { items, available }`** — the envelope that returns **`available: false` on 404/501** for
  not-yet-wired backends (`api.ts` `isUnavailable(status)` → `404 || 501`). This is how the Templates
  panel, the Inbox, and the deliverability tab render a **"connect …" `EmptyState`** instead of an error
  while their backends land.
- **`StateSwitch`** (from **`@leadwolf/ui`**) on every async surface — `loading` / `error` / `empty` /
  `data`, with **`EmptyState`** for the empty branch.
- **Mutations reload** (no optimistic updates in MVP) with **per-action pending state**.
- **`ApiError`** carries the **RFC-9457** machine `code` (`suppressed` 403, `validation_error` 422,
  `not_found`) so a surface can branch on the failure mode while showing the server's message verbatim.

> **Rule for `10` and any new email surface:** copy `features/sequences/{api.ts, hooks/useSequences.ts,
> types.ts}`. Do **not** introduce TanStack Query, SWR, or a client cache. The "loading/empty/error/data"
> four-state requirement in `00 §5` is satisfied by `StateSwitch`, not by a query library.

---

## 4. `navConfig` integration — exactly one new entry, plus reuse

`apps/web/src/components/shell/navConfig.ts` is the **single source of truth** for navigation (the rail,
the top-bar title, the command palette, and the settings scope-nav all read it — `11 §2`,
list-plan precedent). The reality vs. the plan:

- **Primary rail `DESTINATIONS` (today):** Home `/home`, Prospect `/prospect`, Lists `/lists`,
  **Sequences `/sequences`**, **Inbox `/inbox`**, Reports `/reports`. **Sequences and Inbox are already
  rail destinations** — the email surfaces do **not** add new top-level rail items; they fill in the
  Sequences sub-surfaces and wire the Inbox backend.
- **`SETTINGS_NAV` → Workspace scope (today):** General, Members, Auto-enrich, Sessions, Custom fields,
  **"Suppression & DSAR" → `/settings/compliance`**. The compliance surface is **fully built** — **reuse
  it**; no new compliance settings page.

**The single navConfig change M12 makes:** add a **Mailboxes** entry to the **Workspace** scope of
`SETTINGS_NAV`, pointing at the new `/settings/mailboxes` feature (`02`, §1.4). Concretely, insert into the
`scope: "Workspace"` group (alongside "Suppression & DSAR"):

```
{ label: "Mailboxes", href: "/settings/mailboxes", match: "/settings/mailboxes" }
```

There is **no Mailboxes entry today** and **no `/settings/mailboxes` feature today** — both are new. Adding
the entry here is sufficient for the rail/scope-nav/command-palette to pick it up.

**Wiring the existing stubs (no new nav needed):**

- **Templates panel** — already mounted inside `/sequences` as a `MaybeList`-gated STUB; wiring it is
  landing the `/api/v1/templates` backend (`01`), at which point `available` flips to `true`.
- **Inbox replies** — `/inbox` is already a rail destination with `InboxThread` / `InboxTask` contracts;
  wiring is landing `fetchThreads` / `sendReply` / `fetchTasks` backends (`04`, `10`).
- **Reports deliverability** — already a placeholder tab in `/reports`; wiring is feeding the
  `DeliverabilitySection` from `sending_domain` + `email_event` (`08`), flipping it off the "Connect
  sending" `EmptyState`.

---

## 5. Milestone reframe — this is **M12 (extend M9)**, not greenfield

The siblings' framing of the email subsystem as a from-scratch build (`00 §1`, `00 §5`, `00 §8` P0–P6;
`09 §1`) is **superseded by this doc.** The accurate framing:

- **M9 already shipped** the suppression-gated outreach send engine (ADR-0009/0013/0004/0007): the
  Sequence/Step/Enrollment model, the CAN-SPAM-gated send tx, bounce → suppression → credit-back, the
  consent + audit tables, the `/sequences` surface, and the full admin console (§1).
- **M12 is the extension** that turns that engine into a real email product: real sending behind the
  `EmailSenderPort` (`mailbox_integration` + ESP), authenticated `sending_domain`s (SPF/DKIM/DMARC +
  per-tenant tracking CNAME), the high-volume `email_event` store, the per-tenant send-quota, warmup, and
  reputation pools (§2.1).
- **Read the phase map (`00 §8`, `13`) as M12 increments on M9, not P0-from-zero.** Where a phase says
  "build the sequence model" / "build the suppression table" / "build the send path", the correct reading
  is **"the M9 table/path already exists — extend it."** The net-new work is the §2.1 list. The
  isolation itest, the RLS posture, and the four-state UI are **gates on the extension**, not on a fresh
  schema.
- **`email.*` staged rollout** rides the shipped **Feature flags** console (`/feature-flags`, global +
  per-tenant overrides — §1.5), so M12 ships dark and ramps per tenant.

> Net effect: the plan set's depth (deliverability mechanics, isolation guarantees, compliance code paths,
> reporting definitions) is **still all required** — it just lands **on top of M9**, citing the real names
> in §1–§2, not as a parallel `email_*` stack.

---

## 6. Extensibility hooks already present + Locked Decision **D11** in full

M12 is cheap precisely because M9 left the right seams. The four hooks already in the codebase:

1. **`outreach_steps.channel` → multi-channel.** The step model **already** carries `channel`
   (`email`\|`linkedin`). Adding channels (`05`, `07`) is enum + adapter work, not a model change.
2. **`/provider-configs` → `ProviderAdapter`.** The admin **Providers** console already manages ESP/SMS
   provider config — it is the registry the `EmailSenderPort` resolves a tenant's provider against
   (`02`, §1.5).
3. **`webhooks` table → `email.*` event bus.** The shipped outbound webhook registry
   (`packages/db/src/schema/webhooks.ts`, `packages/core/src/webhooks/`) is the subscriber surface for an
   `email.*` event stream (delivered/bounced/replied — `04`), reusing the existing
   `dispatch`/`sign`/`ssrfGuard` machinery.
4. **`creditRepository` → send-quota.** The `SELECT … FOR UPDATE` lock + no-overdraft `CHECK` +
   idempotent grant pattern (`repositories/creditRepository.ts`, ADR-0004/0007) is the **exact** template
   for the per-tenant send-quota counter (§2.1) — copy the discipline, do not reinvent it.

### D11 — Build on, don't duplicate (the locked decision this doc enforces)

> **D11 — Build on, don't duplicate.** The email subsystem **EXTENDS** the M9 outreach engine. It **MUST
> reuse** `outreach_sequences` / `outreach_steps` / `outreach_log` (sequence / step / enrollment),
> `activities` (engagement timeline), `suppression_list` + `assertNotSuppressed` (the **D4** gate),
> `consent_records` (**D9** consent), `idempotency_keys` (**D5**), `audit_log`, the `creditRepository` lock
> pattern (for the new send-quota), and the `EmailSenderPort` seam (for real sending). It **MUST NOT**
> introduce parallel `email_sequence` / `email_sequence_step` / `email_enrollment` / `email_suppression` /
> `email_consent` / `email_idempotency_key` tables. The genuinely **NEW** build is: `sending_domain`
> (+ DKIM/SPF/DMARC + per-tenant tracking CNAME state), `mailbox_integration` (encrypted ESP/OAuth
> credentials + provider), a high-volume **partitioned** raw tracking-event store (`email_event`) that
> **feeds** `activities`, the per-tenant send-quota (built on the `creditRepository` FOR UPDATE pattern),
> warmup, and reputation pools. **This is milestone M12 (extend M9), NOT a greenfield build.**
>
> *Rationale:* a parallel `email_*` stack would fork the suppression gate, the audit trail, the consent
> record, and the idempotency guarantee — i.e. it would create a **second, weaker** path that the
> fail-closed **D4** gate and the **D5** idempotency constraint no longer cover. Reuse keeps a **single**
> enforced send path. D11 has **precedence** over any sibling doc that still names an `email_*` table.

---

## 7. Cross-references

This doc reconciles the whole set; read every sibling through §1–§2.

| Doc | Reconciliation note |
|---|---|
| `00` overview | Adopt D1–D10 as written; **add D11 (§6)**; read "no email subsystem today" (`00 §1`, `§5`) as **superseded** — M9 ships (§1). The §4 vocabulary maps to real names via §2. The P0–P6 map is M12 increments on M9 (§5). |
| `01` templating | Versioned templates **extend** the shipped Templates panel STUB + the `outreach_steps.subject/body` model; not a new subsystem (§2). |
| `02` sending-infrastructure | The send tx is **`core/outreach/sendStep.ts`** (exists); the new work is the `mailbox_integration` + ESP adapter **behind `EmailSenderPort`** + `/settings/mailboxes` (§1.2, §4). |
| `03` deliverability | New `sending_domain` (SPF/DKIM/DMARC + tracking CNAME) — genuinely new (§2.1). |
| `04` status-event-tracking | Engagement = **`activities`** (exists) **+ new partitioned `email_event`** that feeds it; events publish over the existing `webhooks` bus (§2, §6). |
| `05` sequences-automation | Cadences = **`outreach_sequences`/`outreach_steps`/`outreach_log`** (exist) + `channel` multi-channel hook (§1.1, §6). Tick worker extends `apps/workers/src/queues/outreach.ts`. |
| `06` compliance | Suppression = **`suppression_list`** + **`assertNotSuppressed`** (exist, D4); consent = **`consent_records`** (exists, D9); the `/settings/compliance` surface is **fully built** (§1.4). |
| `07` multitenancy-reputation-isolation | Reputation pools build on new `sending_domain` + `mailbox_integration`; isolation itest gates the extension (§5). |
| `08` reporting-analytics | Reply rate reads `outreach_log` + `activities`; the Reports deliverability tab is a placeholder to wire (§1.4, §4). |
| `09` data-model | The "twelve email entities" are reconciled to real tables in §2; the only net-new schema is §2.1. Read `09`'s `email_*` names through this mapping. |
| `10` web-surface | **Vanilla React + `fetchWithAuth` + `MaybeList` + `StateSwitch`** — **not** TanStack (§3). `/sequences` is built; `/inbox` + deliverability are stubs to wire; add the one **Mailboxes** nav entry (§4). |
| `11` admin-surface | The admin console is **fully built** (§1.5) — extend `/tenants`, `/provider-configs`, `/feature-flags`, `/system-health`; don't rebuild. |
| `12` roles-permissions | Real roles: `requireRole` (workspace), `requireOrgRole` (org), `platformAdmin` + `requireStaffRole` (staff). **Break-glass = the shipped Users impersonation** (time-boxed, audited — §1.5). Two-check rule + IDOR→404 + server-side client-ID re-resolution under RLS hold. |
| `13` rollout-phases | Re-read as **M12 increments on M9** (§5); ride the **Feature flags** console for `email.*` staged rollout. |
| `15` | The next sibling builds on this ground-truth; it must cite the real names in §2 and honour **D11** (§6). |

---

**Ground-truth basis:** all paths and table/column/route names above are real in `main` as of 2026-06-24
— `packages/db/src/schema/{outreach,billing,compliance,activity,contacts,auth,webhooks}.ts`;
`packages/core/src/outreach/{createSequence,enrollContact,sendStep,handleBounce,senderPort}.ts`,
`packages/core/src/compliance/{assertNotSuppressed,writeAudit}.ts`,
`packages/db/src/repositories/{creditRepository,outreachLogRepository,suppressionRepository}.ts`;
`apps/api/src/features/outreach/routes.ts`, `apps/api/src/features/admin/`;
`apps/workers/src/queues/{outreach,dsar}.ts`;
`apps/web/src/features/sequences/{api,types}.ts`, `apps/web/src/components/shell/navConfig.ts`,
`apps/web/src/lib/authClient.ts`;
`apps/admin/src/features/{tenants,users,provider-configs,feature-flags,staff,audit-log,system-health}/`.
ADRs: **ADR-0009** (outreach engine), **ADR-0013** (credit-back), **ADR-0004** (credit idempotency),
**ADR-0007** (per-workspace credit counter), **ADR-0016** (in-memory access token).
