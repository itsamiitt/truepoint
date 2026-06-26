# Email Subsystem — Overview & Decisions (00)

> **Status:** Plan (not yet built). **Owner:** Product + Platform. **Last updated:** 2026-06-24.
> This is the **anchor / spine** document for the `docs/planning/email-planning/` set, mirroring the
> shipped `docs/planning/list-plan/` set. The **Locked Decisions (D1–D11)**, **Shared Vocabulary**,
> **Canonical Entities**, and **Phase Map (P0–P6)** below are canonical — every other doc in this folder
> cites them verbatim and **must not contradict them**. This doc **owns the document index** in §9.
>
> **This is milestone M12 — it EXTENDS the shipped M9 outreach engine, it is not a greenfield build**
> (see **D11**, §5.1). The M9 send transaction, suppression gate, sequence/step/enrollment tables, and
> the engagement timeline already exist; the email subsystem reuses them verbatim and adds only the
> genuinely-new sending infrastructure on top.

---

## 1. Why we're building this

TruePoint already lets a workspace **find and own a book of prospects** (the Prospect surface, the List
tab + import/enrichment, and the Sequences surface the List tab hands off to). It **also already ships an
M9 outreach engine** — a suppression-gated, idempotent, CAN-SPAM-blocking send transaction over real
`outreach_sequences` / `outreach_steps` / `outreach_log` tables, with a fully-built `/sequences` surface
and a built `/settings/compliance` surface (see §5.1). What it does **not** yet have is the layer that
turns that engine into **production outbound at scale**: real authenticated sending domains, connected
customer mailboxes, high-volume tracking, per-tenant reputation isolation, send quotas, and warmup.
**The send engine exists; the production sending infrastructure on top of it does not.** This plan set is
**milestone M12 — it extends M9, it does not rebuild it** (**D11**, §5.1).

The email infrastructure is the **production-grade layer atop the M9 engine, Lists + Sequences**. A
seller's job does not end at "I have
200 verified, owned prospects" — it ends at "I emailed them, three replied, and I booked two meetings." A
sales-intelligence platform that stops at data is a database; a platform that owns the **outbound motion**
is a sales-engagement platform. **To be a real sales-engagement platform, TruePoint must own outbound** —
not rent it from a third-party that holds the mailbox relationships, the deliverability reputation, and
the reply data.

This is also, by a wide margin, **the highest-risk subsystem TruePoint will build**. It is the first
subsystem where:

- **A bug is visible to people outside the tenant** — a double-send, a wrong-merge variable, or a missed
  suppression is not an internal data error; it is an email that landed in a stranger's inbox.
- **One tenant's behaviour can damage another's** unless reputation is isolated (the core reason for **D2**
  and doc `07`). Shared sending reputation is how multi-tenant email platforms quietly fail.
- **Compliance is non-optional and externally enforced** — Google and Yahoo began rejecting non-compliant
  bulk mail in 2024 (§6, doc `03`), and CAN-SPAM / GDPR / DPDP carry real penalties (doc `06`).
- **Secrets are live credentials to a customer's real mailbox** (OAuth tokens, SMTP passwords) — a leak is
  account takeover, not a data peek (**D7**, doc `02`).

Intended outcome: a seller can author a template, enroll a list into a sequence, and have TruePoint send
from **their own connected mailbox**, on **their tenant's own authenticated sending domain**, with
**suppression and consent enforced on every send**, replies threaded back into a unified inbox, and the
result reported as a **reply rate** — all without TruePoint ever co-mingling one tenant's sending
reputation, secrets, or data with another's.

## 2. Core jobs / scope

The email subsystem does eight things. Each is owned in depth by a sibling doc (§9).

| # | Core job | What it does | Owned by |
|---|----------|--------------|----------|
| 1 | **Connect mailboxes & domains** | Connect a sending identity (Google/Microsoft OAuth or SMTP/ESP) and authenticate a tenant-owned sending domain (SPF/DKIM/DMARC). | `02`, `03` |
| 2 | **Author templates** | Create reusable, versioned subject+body artifacts with variables and fallbacks; owner-scoped and shareable; render-safe (no untrusted template eval). | `01` |
| 3 | **Run sequences** | Build ordered, multi-step cadences with scheduling, branching, throttling, and auto-pause-on-reply; enroll People from Lists. | `05` |
| 4 | **Send 1:1 + automated mail** | Queue and deliver single outbound emails — manual 1:1 from a mailbox, or automated as a sequence step — idempotently, suppression-gated. | `02`, `05` |
| 5 | **Track events** | Capture opens, clicks, replies, bounces, unsubscribes, complaints, and deliveries per send; surface a per-contact timeline, reply detection, and a unified inbox. | `04` |
| 6 | **Manage deliverability** | Warm up new mailboxes/domains, monitor reputation and blacklists, run seed/placement checks, surface a deliverability dashboard. | `03` |
| 7 | **Enforce compliance** | Suppression, consent/lawful-basis, one-click List-Unsubscribe (RFC 8058), CAN-SPAM physical address + honest headers, GDPR/DPDP DSAR cascade. | `06` |
| 8 | **Report** | Reply rate (primary KPI), click rate, deliverability/placement, send reliability, per-mailbox/per-rep leaderboards and analytics. | `08` |

### In scope (this plan set — M12, extending M9)

> Everything here builds on the shipped M9 engine (§5.1). The genuinely-new build is sending domains,
> mailbox integrations, the high-volume raw tracking-event store, the per-tenant send-quota, warmup, and
> reputation pools (**D11**). The sequence/step/enrollment tables, the suppression gate, consent records,
> idempotency keys, the send transaction (`core/outreach/sendStep`), and the engagement timeline already
> exist and are **reused, not rebuilt**.

- **Mailbox-based 1:1 and automated sending** from connected Google/Microsoft (OAuth) and SMTP identities,
  with a relay/transactional ESP backbone for platform/system mail (per **D1**) — wired into the existing
  `EmailSenderPort` seam so real sending swaps the port without touching the M9 send transaction.
- **Per-tenant reputation isolation** — own sending domain/subdomain, own mailbox pool, own custom
  tracking domain (**D2**, **D3**; doc `07`).
- **Templates** (versioned, owner-scoped, shareable, render-safe), **sequences** (cadences with branching,
  scheduling, auto-pause-on-reply), and the **/web Email surface** (Templates, Sequences, Inbox,
  Deliverability, Analytics tabs — doc `10`).
- **Full event tracking** + **unified inbox** + **reply detection** (doc `04`).
- **Compliance** enforced not advised (**D9**; doc `06`) and **multi-tenant isolation** proven by itest.
- The **/admin email console** for mailbox/domain management, per-tenant limits/reputation, global
  suppression, email-volume billing, and the DSAR cascade (doc `11`).
- **Roles & permissions** for owner-scoped visibility with manager/admin override (**D8**; doc `12`).

### Out of scope (explicitly, for now)

- **Non-email channels** (LinkedIn, SMS, WhatsApp, dialer) — the sequence model leaves room for them but
  this set ships **email steps only**.
- **AI authoring / autonomous "AI SDR"** beyond simple variable fallbacks — noted as roadmap, not built.
- **Dedicated outbound IPs** — supported as an *optional* part of a Reputation Pool but not a P0–P6
  deliverable; the default is per-tenant authenticated domain + mailbox pool.
- **Multi-region residency siloing of email data** — carried as a known gap (constraints digest), not built
  here.

## 3. Locked decisions (D1–D11 — canonical; cite by ID, never contradict)

> Confirmed for this set. Each carries a one- to two-sentence rationale. They are **not open for
> re-litigation** inside the other docs; downstream docs add depth, never reversal. Each will be backed by
> an `ADR-NNNN-email-*.md` in `docs/planning/decisions/`.

- **D1 — Hybrid provider strategy.** 1:1 sales mail sends **mailbox-based** (Google/Microsoft OAuth + SMTP)
  so it lands in a real inbox, threads replies, and inherits the mailbox's own deliverability; platform /
  system / bulk mail goes over a **relay/transactional ESP** — **Amazon SES** as the default backbone,
  **Postmark** for highest-deliverability system mail, **SendGrid/Mailgun** as alternates. *Rationale:*
  cold sales mail belongs in a human's real mailbox, not a shared marketing IP; system mail belongs on a
  hardened relay. **No shared-IP bulk for cold sales** (tradeoff matrix in `02`).
- **D2 — Reputation isolation is per-tenant.** Each tenant sends from its **own authenticated sending
  domain/subdomain** and its **own mailbox pool**; **no sending domain is ever shared across tenants**, and
  one tenant's complaints/bounces never touch another's reputation. *Rationale:* shared reputation is how
  multi-tenant email platforms fail — one bad actor poisons everyone (this is the **highest-risk**
  decision; detailed in `07`).
- **D3 — Custom tracking domain per tenant.** Open/click tracking uses a **tenant-specific CNAME tracking
  domain**, never a shared one. *Rationale:* a shared tracking host becomes a single blacklistable
  reputation surface and links one tenant's engagement to another's; per-tenant CNAMEs isolate it (doc
  `04`, `07`).
- **D4 — Suppression gates every send, fail-closed.** A send is blocked **both at enqueue and at dequeue**
  if the address/Person is suppressed or lacks consent, checked **tenant + workspace scoped**. *Rationale:*
  suppression is a legal and reputational hard line; checking only at enqueue races against
  late-arriving unsubscribes, so the dequeue-time check is the fail-closed backstop (doc `06`).
- **D5 — Sends are idempotent.** Every send carries an **Idempotency-Key** plus a **unique DB constraint**;
  at-least-once queues never double-send. *Rationale:* BullMQ is at-least-once by design — without an
  idempotency key + unique constraint, a retried job sends the same email twice to a real person (doc
  `02`; reuses the shipped **`idempotency_keys`** table, `UNIQUE(tenant_id, key)` — **D11**, not a new
  `email_idempotency_key`).
- **D6 — Opens are informational, not the KPI of record.** **Reply rate is the primary KPI** (with careful
  click rate); opens are shown but **de-emphasized**. *Rationale:* Apple Mail Privacy Protection pre-fetches
  and proxy-prefetch inflate opens — roughly doubling reported open rates — so an opens-based KPI is
  measuring a robot, not a buyer (§6, doc `04`, `08`).
- **D7 — Secrets stay server-side.** Mailbox OAuth tokens and SMTP/ESP credentials are **encrypted at rest**
  (KMS target; app-AES-GCM today), **never sent to the client, never logged**. *Rationale:* these are live
  credentials to a customer's real mailbox — a leak is account takeover, not a data peek (doc `02`,
  security precedence).
- **D8 — Owner-scoped visibility by default.** Templates, sequences, sends, and analytics are visible to
  the **owner + explicit shares + workspace-role**; cross-rep visibility requires **manager/admin**.
  *Rationale:* a rep's outbound and reply data is sensitive performance data; defaulting it open would leak
  pipeline across the floor — **non-negotiable** (doc `12`).
- **D9 — Compliance enforced, not advisory.** **One-click List-Unsubscribe (RFC 8058)** on marketing
  sends; **consent / lawful basis recorded**; **CAN-SPAM** physical address + honest headers; **GDPR/DPDP
  DSAR cascade** removes a Person from all unsent enrollments and suppresses them. *Rationale:* Google/Yahoo
  reject non-compliant bulk mail (§6) and regulators fine — compliance must be a code path the system
  enforces, not a checkbox in the UI (doc `06`).
- **D10 — Fan-out + ingestion are queue-backed.** BullMQ queues **`email_send`**, **`email_tracking`**,
  **`email_warmup`**, **`email_sequence_tick`**; **tenant context is set per job**; **per-tenant and
  per-mailbox throttling** lives in-queue. *Rationale:* sending and event ingestion are bursty and must be
  backpressured, retried, and rate-limited per tenant/mailbox or one big sequence starves everyone (doc
  `02`, `05`; constraints digest — Queues).
- **D11 — Build on, don't duplicate.** The email subsystem **EXTENDS the M9 outreach engine**. It MUST
  reuse **`outreach_sequences`** / **`outreach_steps`** / **`outreach_log`** (sequence / step / enrollment),
  **`activities`** (engagement timeline), **`suppression_list`** + **`assertNotSuppressed`** (the **D4**
  gate), **`consent_records`** (**D9** consent), **`idempotency_keys`** (**D5**), **`audit_log`**, the
  `creditRepository` lock pattern (for the new send-quota), and the **`EmailSenderPort`** seam (for real
  sending). It MUST NOT introduce parallel `email_sequence` / `email_sequence_step` / `email_enrollment` /
  `email_suppression` / `email_consent` / `email_idempotency_key` tables. The genuinely **NEW** build is:
  **`sending_domain`** (+ DKIM/SPF/DMARC + per-tenant tracking-CNAME state), **`mailbox_integration`**
  (encrypted ESP/OAuth credentials + provider), a high-volume **PARTITIONED raw tracking-event store
  (`email_event`)** that **feeds `activities`**, the **per-tenant send-quota** (built on the
  `creditRepository` `SELECT … FOR UPDATE` pattern), **warmup**, and **reputation pools**. *Rationale:* a
  shipped, suppression-gated, idempotent, CAN-SPAM-blocking send transaction already exists in
  `packages/core/src/outreach/`; rebuilding it as a parallel `email_*` schema would fork the suppression
  gate and the audit trail — the two things that must never diverge. **This is milestone M12 (extend M9),
  NOT a greenfield build.** (Reuse map in §5.1; entity ownership in doc `09`; integration in doc `14`.)

## 4. Shared vocabulary (canonical)

> These exact terms and entity names are used verbatim across all 16 docs. Entities are **owned by doc
> `09`** (§9); this glossary defines them in plain English. **The names below are the REAL, shipped table
> and code names** — per **D11**, the email subsystem reuses them and does **not** introduce parallel
> `email_*` equivalents. Only **Sending Domain**, **Mailbox**, and **Send Quota** are genuinely new.

**Reused from the shipped M9 engine (do not duplicate — D11):**

- **Sequence (Cadence)** — an **ordered, multi-step outreach** flow (`status` active / paused / archived;
  `from_address` + `physical_address` for CAN-SPAM). Entity: **`outreach_sequences`**.
- **Step** — one ordered step of a sequence (`channel` email / linkedin, `delay_hours`, `subject`, `body`).
  Entity: **`outreach_steps`** (`UNIQUE(sequence_id, step_order)`).
- **Enrollment** — a **contact enrolled into a sequence** (`status` enrolled / active / replied /
  completed / unsubscribed / bounced; `current_step`). Entity: **`outreach_log`**
  (`UNIQUE(sequence_id, contact_id)` = enrollment idempotency).
- **Tracking / engagement timeline** — the per-contact event stream of **`email_sent` / `email_opened` /
  `email_clicked` / `email_replied`** (and other channels). Entity: **`activities`**; high-volume raw
  open/click/bounce/complaint webhook payloads land first in the **NEW partitioned `email_event` store**
  (§5.1, **D11**), which **feeds `activities`** — `activities` is never written directly from a raw
  pixel/webhook hit.
- **Suppression** — an address / domain / phone / contact **blocked from sends** (unsubscribe, hard-bounce,
  complaint, manual, DNC); **scope** global / tenant / workspace; matched by `email_blind_index` /
  `domain` / `phone_blind_index` / `contact_id`. Entity: **`suppression_list`**; the gate is
  **`assertNotSuppressed`** (runs in the reveal AND send tx — **D4**).
- **Consent** — a recorded **lawful basis / opt state** per contact + jurisdiction (`lawful_basis`
  legitimate_interest / consent / contract / public_record; `valid_from` / `valid_until` / `withdrawn_at`).
  Entity: **`consent_records`** (**D9**).
- **Idempotency** — the **`Idempotency-Key` + unique constraint** that makes billable creates and sends
  exactly-once over at-least-once queues (**D5**). Entity: **`idempotency_keys`**
  (`UNIQUE(tenant_id, key)`).
- **Send transaction** — the shipped tx that blocks unless `from_address` + `physical_address` are present,
  re-runs `assertNotSuppressed` in-tx, auto-appends the postal + unsubscribe footer, sends via the
  injected `EmailSenderPort`, advances `outreach_log`, and audits the send. Code:
  **`packages/core/src/outreach/sendStep.ts`**.
- **Bounce handling** — the idempotent path that marks bounced, inserts a workspace suppression row, and
  does the ADR-0013 credit-back. Code: **`packages/core/src/outreach/handleBounce.ts`**.
- **Sender** — the seam real sending plugs into. Port: **`EmailSenderPort`**
  (`packages/core/src/outreach/senderPort.ts`; `consoleSender` today). The M12 SES / mailbox adapter swaps
  the port **without touching the send tx** (entity: **`mailbox_integration`**, below).

**Genuinely new in M12 (built on top — D11):**

- **Mailbox** — a connected **sending identity** (Google/Microsoft OAuth, or SMTP/ESP), owned by a user
  within a workspace, holding **encrypted credentials** (**D7**) and a provider. Entity:
  **`mailbox_integration`** (the concrete `EmailSenderPort` adapter).
- **Sending Domain** — a **tenant-owned domain or subdomain** authenticated for sending (SPF/DKIM/DMARC)
  with per-tenant tracking-CNAME state (**D2**, **D3**). Entity: **`sending_domain`**.
- **Send Quota** — the **per-tenant outbound-volume counter** enforced at send time, built on the
  shipped `creditRepository` `SELECT … FOR UPDATE` lock + no-overdraft CHECK pattern (ADR-0007). New
  counter; **same lock template, not a new mechanism.**
- **Reputation Pool** — the **isolation unit for sending reputation**: a per-tenant sending domain +
  mailbox set (+ optional dedicated IP) (**D2**, doc `07`).
- **Warmup** — the **gradual volume ramp** of a new mailbox / domain / IP (doc `03`).

## 5. What we build on (existing TruePoint infrastructure, reused)

The email subsystem is **not new and not greenfield** — a working M9 outreach engine, two built customer
surfaces, and a fully-built admin console already ship (§5.1, **D11**). M12 extends them and sits on the
same platform every other TruePoint subsystem uses, and must cite (not re-derive) the **TruePoint
constraints digest**:

### 5.1 Current state — what already exists (the M9 base for M12)

> **Authoritative reuse map (D11).** Doc `14-current-state-integration` owns the full integration; this is
> the canonical summary. Every entity / module / surface below already ships and is **reused, not rebuilt**.

**Shipped data model** (`packages/db/src/schema/`):

| Concern | Real table(s) | File | Notes |
|---|---|---|---|
| Sequence / step / enrollment | `outreach_sequences`, `outreach_steps`, `outreach_log` | `outreach.ts` | `outreach_log` `UNIQUE(sequence_id, contact_id)` = enrollment idempotency. |
| Suppression + idempotency + audit | `suppression_list`, `idempotency_keys`, `audit_log` | `billing.ts` | `audit_log.action` is a closed enum incl. `send` / `enroll` / `unsubscribe` / `suppression.add`. |
| Consent / DSAR | `consent_records`, `dsar_requests` | `compliance.ts` | Lawful basis + jurisdiction per contact. |
| Engagement timeline | `activities` (`email_sent` / `email_opened` / `email_clicked` / `email_replied`) | `activity.ts` | The NEW `email_event` raw store feeds this. |
| Contacts / accounts | `contacts` (`outreach_status`, `email_blind_index`, …), `accounts`, `source_imports` | `contacts.ts` | `outreach_status`: new / in_sequence / replied / meeting_booked / disqualified / nurture / unsubscribed. |
| Tenancy / credits / webhooks | `tenants` (`reveal_credit_balance`), `users`, `tenant_members`, `platform_staff`, `workspaces`, `webhooks` | `auth.ts`, `webhooks.ts` | `webhooks` is reused as the external `email.*` event bus. |

**Shipped core logic** (`packages/core/src/`):

- `outreach/createSequence.ts`, `outreach/enrollContact.ts` (revealed-only + `assertNotSuppressed` in-tx +
  idempotent + audit), `outreach/sendStep.ts` (**THE send tx** — CAN-SPAM-blocking, suppression-gated,
  footer-appending, port-driven), `outreach/handleBounce.ts` (idempotent bounce → suppress + ADR-0013
  credit-back), `outreach/senderPort.ts` (`EmailSenderPort`, `consoleSender` today).
- `compliance/assertNotSuppressed.ts` (the unbypassable **D4** gate), `compliance/writeAudit.ts`.
- `billing/creditRepository` (`lockBalance` via `SELECT … FOR UPDATE`; decrement under lock with
  no-overdraft CHECK; idempotent `grantFromEvent`) — **the template for the new per-tenant send-quota.**

**Shipped API / workers:** `apps/api/src/features/outreach/routes.ts` mounted **`/api/v1/outreach`**
(`GET/POST /sequences`, `POST /sequences/:id/steps`, `POST /sequences/:id/enroll` [201 new / 200
already-enrolled], `/enroll-bulk`, `GET /sequences/:id/log`, `POST /log/:id/send` [dev `consoleSender`],
`POST /log/:id/bounce`); `apps/api/src/features/admin/` (platformAdmin). Workers:
`apps/workers/src/queues/outreach.ts` (`processOutreach` → `sendStep`), `dsar.ts`. ADRs: **ADR-0009**
(outreach engine; suppression gates sending; sending domains / DKIM / SPF / DMARC / warmup / bounce as
consequences), **ADR-0013** (credit-back), **ADR-0004** (credit idempotency), **ADR-0007** (per-workspace
credit counter).

**Shipped customer surfaces** (`apps/web/src/`):

- **`/sequences` — FULLY BUILT** (`SequenceList`, `SequenceBuilder`, `EnrollmentPanel`,
  `EnrollmentLogTable`, `SendStatusDashboard`, metrics funnel) with a **Templates panel STUB**
  (`fetchTemplates` → `MaybeList available:false`; `TemplateSummary{id,name,channel,subject,body,updatedAt}`)
  and an **AI `DraftReviewPanel` STUB**.
- **`/inbox` — CONTRACTS DEFINED, backend 404/501** (`InboxThread{channel, messages, assignee, sequenceId}`,
  `InboxTask`; `fetchThreads` / `sendReply` / `fetchTasks`).
- **`/reports` — six dashboards**; the **"Sending & deliverability" tab is a PLACEHOLDER** (StatTiles "—",
  `DeliverabilitySection` EmptyState "Connect sending").
- **`/settings/compliance` — FULLY BUILT** (`SuppressionForm`, `SuppressionList`, `DsarForm`;
  `addSuppression` / `listSuppressions` / `removeSuppression` / `submitDsar`).
- **No `/settings/mailboxes` feature exists** — `navConfig.ts` (the single nav source of truth) has **no
  Mailboxes entry**; M12 **adds one to the Workspace settings scope** (doc `10`).

**Shipped admin console** (`apps/admin/src/` — FULLY BUILT, not a stub): **Tenants** `/tenants`,
**Users** `/users` (+ time-boxed, audited impersonation = the existing **break-glass**), **Providers**
`/provider-configs` (the home for the pluggable ESP `ProviderAdapter` registry), **Feature flags**
`/feature-flags` (global + per-tenant overrides — the home for `email.*` staged rollout), **Staff**
`/staff`, **Audit log** `/audit-log`, **System health** `/system-health` (the home for email queue /
ingestion SLOs). M12 adds email panels to these existing pages — it does **not** build a new console.

**The frontend data pattern is vanilla React, NOT TanStack Query** (ADR-0016): `useState` / `useCallback`,
`fetchWithAuth` (in-memory access token) in feature `api.ts`, the `MaybeList<T>{items, available}` envelope
(`available:false` on 404/501 for not-yet-wired backends), `StateSwitch` (loading / error / empty / data)
+ `EmptyState` from `@leadwolf/ui`, mutations reload (no optimistic MVP), per-action pending state.
Representative: `features/sequences/{api.ts, hooks/useSequences.ts}`. **No `useQuery` / query-keys.**

- **Tenancy / RLS** — `tenant_id` + `workspace_id` on every row; Postgres **RLS ENABLE + FORCE,
  fail-closed `NULLIF`**, transaction-local GUCs (`SET LOCAL`), `tenant_id`-leading composite indexes.
  Workers set tenant context per job (**D10**). The reused M9 tables already carry this posture; the
  **new** M12 entities (`sending_domain`, `mailbox_integration`, `email_event`, send-quota) land in their
  own schema files (e.g. `packages/db/src/schema/sending.ts`) with matching RLS, **never as parallel
  `email_*` equivalents of the M9 tables** (**D11**; entity ownership in doc `09`).
- **API contract** — Hono on Bun under **`/api/v1`**; **Zod schemas in `@leadwolf/types`** as single source
  of truth; **cursor (never offset) pagination** with a server-max limit; **Idempotency-Key on billable
  creates** (every send — **D5**, via the shipped `idempotency_keys` table); **RFC 9457
  `application/problem+json`** errors (machine code, no PII/stack); per-user + per-tenant rate limits with
  `Retry-After`. Shipped outreach routes mount at `/api/v1/outreach`; new M12 routes (mailbox/domain
  connect, deliverability) extend that feature or add `apps/api/src/features/email/` for genuinely-new
  surfaces (§5.1, doc `14`).
- **Queues** — **BullMQ/Redis**, named purpose queues (**D10**), idempotent at-least-once, backoff + DLQ,
  backpressure-bounded fan-out, user-visible job states + progress. Workers at
  `apps/workers/src/queues/email*.ts`.
- **Design system** — **`@leadwolf/ui`** components only; **`var(--tp-*)`** tokens (no hardcoded hex/px);
  four states via `StateSwitch` (loading/empty/error/data); virtualized large tables + cursor pagination;
  **WCAG 2.2 AA**; i18n; light theme only. Web feature at `apps/web/src/features/email/`.
- **Ownership model** — owner-scope + explicit sharing + workspace-role (**D8**); **references, not copies**
  (`outreach_log` references the canonical contact / sequence, never copies them; the new `email_event`
  rows reference the enrollment, never duplicate the contact); dedup/uniqueness constraints (e.g.
  `outreach_log` `UNIQUE(sequence_id, contact_id)`).
- **Audit** — the shipped append-only `audit_log` storing **IDs + actions, NEVER PII or message bodies**
  (closed `action` enum incl. `send` / `enroll` / `unsubscribe` / `suppression.add`) — reused, not
  re-created.
- **DSAR** — the existing `dsar_requests` cascade pattern (find all tenant references for a contact,
  soft+hard delete per retention) extended to suppress + dis-enroll across the reused outreach entities
  (**D9**, doc `06`).
- **Pure domain logic** — the shipped `packages/core/src/outreach/` (send tx, enroll, bounce, sender port)
  and `compliance/` (suppression gate, audit) are reused; new render / scheduling / deliverability rules
  live alongside them, framework-free.

> **Security precedence holds:** on any access, tenant-isolation, secret, PII, or compliance point,
> **security wins**. Platform owns the tenancy mechanism (RLS), the API contract, and scale; data owns the
> model + ownership; design defers to security on whether data/input is safe. (CLAUDE.md precedence.)

## 6. Industry landscape synthesis

TruePoint's target seat is **enterprise-grade, multi-tenant, mailbox-based, with per-tenant reputation
isolation** (**D1**, **D2**). The eight reference platforms cluster into three camps — *enterprise sales
engagement* (Outreach, Salesloft), *all-in-one prospect-to-send* (Apollo, HubSpot, Reply.io), and
*high-volume cold-email infrastructure* (Instantly, Smartlead, Lemlist). TruePoint should take the
**deliverability and mailbox-rotation discipline of the cold-email camp**, the **CRM-grade ownership,
compliance and reporting of the enterprise camp**, and **own the data + the send** the way the all-in-one
camp does — but with **true per-tenant isolation** none of them advertises as a first-class guarantee.

- **Outreach** — the mature enterprise sales-engagement floor: multi-step sequences across email, dialer,
  LinkedIn and tasks, with deliverability tooling built for high-volume enterprise teams; wins for
  enterprise AEs managing complex pipeline. *TruePoint sits here on structure and governance, but
  mailbox-based + per-tenant-isolated.*
  [forecastio.ai](https://forecastio.ai/blog/best-sales-engagement-software),
  [buzzlead.io](https://buzzlead.io/blogs/hubspot-vs-salesloft-vs-outreach-vs-apollo-honest-sales-engagement-comparison-20)
- **Salesloft** — revenue-team cadence platform strongest in call coaching and conversation intelligence;
  robust cadence controls but leans on third-party tools for warmup and inbox placement. *TruePoint should
  not externalize warmup — it builds it in (doc `03`).*
  [salesrobot.co](https://www.salesrobot.co/blogs/apollo-vs-salesloft),
  [salesforge.ai](https://www.salesforge.ai/blog/apollo-vs-salesloft)
- **Apollo** — the all-in-one prospecting + sequencing leader for outbound-first teams under enterprise
  budget; maintains sender reputation via deliverability scoring, automatic warmup, inbox-setup guidance,
  and built-in SPF/DKIM/DMARC support with real-time deliverability insights. *Closest functional analog;
  TruePoint differentiates on multi-tenant isolation + enterprise governance.*
  [apollo.io](https://www.apollo.io/insights/how-do-i-choose-an-outbound-sales-platform-that-prioritizes-email-deliverability),
  [buzzlead.io](https://buzzlead.io/blogs/hubspot-vs-salesloft-vs-outreach-vs-apollo-honest-sales-engagement-comparison-20)
- **Reply.io** — multichannel outreach (email, LinkedIn, calls, SMS, WhatsApp) with an AI layer (Jason AI
  SDR) that prospects, sends, and auto-replies; positions on AI personalization at scale. *TruePoint leaves
  room in the sequence model for channels + AI but ships email first; AI authoring is roadmap, not P0.*
  [reply.io](https://reply.io/),
  [snov.io](https://snov.io/blog/reply-io-review/)
- **HubSpot** — CRM-native: **one-to-one sales sequences** use the rep's connected mailbox, while
  **marketing + transactional** mail uses authenticated sending domains and an add-on **dedicated IP** —
  the same hybrid split TruePoint formalizes in **D1**. Validates the mailbox-vs-relay separation as the
  enterprise norm. *TruePoint mirrors the split but makes per-tenant isolation the default, not an
  enterprise add-on.*
  [knowledge.hubspot.com](https://knowledge.hubspot.com/marketing-email/understand-email-sending-in-hubspot),
  [community.hubspot.com](https://community.hubspot.com/t5/Email-Deliverability/How-Do-You-Manage-Sales-Sequences-vs-Marketing-Emails-in-HubSpot/m-p/1130619)
- **Instantly** — high-volume cold-email infrastructure optimized for inbox placement at scale, with smart
  sending limits, send-time randomization, automatic bounce detection, and one of the largest warmup
  networks (a multi-million-mailbox warmup pool). *TruePoint adopts the smart-throttle + warmup discipline
  (**D10**, doc `03`) without a shared warmup co-op that would breach isolation.*
  [devcommx.com](https://www.devcommx.com/blogs/instantly-vs-smartlead-vs-lemlist-2026),
  [sparkle.io](https://sparkle.io/blog/smartlead-vs-instantly/)
- **Smartlead** — best-in-class **mailbox rotation** distributing sends across many connected mailboxes at
  the account level (not just per-campaign), unlimited inboxes per workspace, achieving high reported inbox
  rates. *TruePoint's Reputation Pool + mailbox pool is the multi-tenant, isolated expression of this
  rotation idea (doc `07`).*
  [sparkle.io](https://sparkle.io/blog/smartlead-vs-instantly/),
  [devcommx.com](https://www.devcommx.com/blogs/instantly-vs-smartlead-vs-lemlist-2026)
- **Lemlist** — personalization-heavy outbound (dynamic images/video, custom variables) for lower-volume,
  high-creativity campaigns; all-in-one multichannel feel. *TruePoint's versioned templates + variables +
  fallbacks (doc `01`) cover the personalization need; render-safety (no untrusted template eval) is the
  guardrail Lemlist-style dynamic content makes essential.*
  [grouglobal.com](https://grouglobal.com/blog/lemlist-vs-smartlead),
  [aioutreachtool.com](https://aioutreachtool.com/lemlist-vs-smartlead/)

### Cross-cutting realities every platform now lives with

These are industry-wide constraints, not platform features — **TruePoint must treat them as ground truth**.
Depth lives in docs `03` (deliverability) and `04` (tracking).

- **Google & Yahoo 2024 bulk-sender rules (effective Feb 2024).** Any sender above **5,000 messages/day**
  to Gmail/Yahoo must: authenticate with **SPF *and* DKIM**, publish **DMARC** (minimum `p=none`) with
  From-header alignment, support **one-click unsubscribe** via `List-Unsubscribe` + `List-Unsubscribe-Post:
  List-Unsubscribe=One-Click` (**RFC 8058**) on marketing/subscribed mail, and keep the
  **Postmaster-reported spam complaint rate below 0.30%** (target **< 0.10%**). Enforcement (rejection of
  non-compliant traffic) phased in from April 2024. This is the externally enforced floor behind **D3**,
  **D4**, and **D9**. (See doc `03` for SPF/DKIM/DMARC mechanics; doc `06` for unsubscribe/consent.)
  [support.google.com](https://support.google.com/a/answer/81126),
  [mailgun.com](https://www.mailgun.com/state-of-email-deliverability/chapter/yahoogle-bulk-senders/),
  [dmarcian.com](https://dmarcian.com/yahoo-and-google-dmarc-required/)
- **Apple Mail Privacy Protection (MPP).** Since iOS/macOS 15 (and enabled on a large majority of Apple
  Mail devices), Apple **pre-fetches images through a proxy and masks IP**, firing the tracking pixel even
  when the recipient never reads the message — roughly **doubling reported open rates**. Clicks, replies,
  and conversions are the reliable signals. This is the direct justification for **D6** (opens
  informational, **reply rate** is the KPI). (See doc `04` for how tracking events are recorded and
  flagged; doc `08` for reporting.)
  [mailchimp.com](https://mailchimp.com/help/apple-privacy-faq/),
  [beehiiv.com](https://www.beehiiv.com/blog/apple-mpp-open-rate),
  [paubox.com](https://www.paubox.com/blog/how-apple-mail-privacy-protection-inflates-email-open-rates)

## 7. Success metrics

These are the outcome measures the subsystem is judged by. Definitions and dashboards live in doc `08`;
deliverability mechanics in `03`; the isolation guarantee in `07`.

- **Deliverability / inbox placement** — measured by seed/placement checks and bounce/complaint rates, not
  raw "sent" counts. Target: per-tenant spam complaint rate **< 0.10%** (well under the Google/Yahoo 0.30%
  hard line, §6); zero domains on major blacklists; warmup ramps complete without placement collapse.
- **Reply rate — the PRIMARY KPI (per D6).** Replies (and careful click rate) are the engagement measure of
  record; opens are shown but de-emphasized because MPP inflates them (§6).
- **Send reliability / SLO** — every queued send is delivered or surfaced as a failed job state; **zero
  double-sends** (enforced by **D5** idempotency); documented p95 enqueue→send latency SLO; DLQ drains;
  per-tenant/per-mailbox throttles never silently drop mail (**D10**).
- **Compliance posture** — 100% of marketing sends carry one-click List-Unsubscribe (RFC 8058); every send
  passes the fail-closed suppression + consent gate (**D4**); CAN-SPAM physical address + honest headers
  present; DSAR deletion **provably cascades** to suppress + dis-enroll (**D9**).
- **Per-tenant isolation guarantee** — **0 cross-tenant leaks** in the isolation itest (no shared sending
  domain, tracking domain, mailbox, suppression list, or reputation between tenants — **D2**, **D3**); one
  tenant's complaints demonstrably do not move another tenant's reputation.

## 8. Milestone map (P0–P6)

> Owned in full by doc `13-rollout-phases.md`. Sequenced **highest-risk-first** — isolation and the send
> path before the features that ride on them.

| Phase | Headline | Risk |
|-------|----------|------|
| **P0** | **Foundations** — data model + RLS + cross-tenant isolation itest; mailbox connect (OAuth) + secret storage; sending-domain DNS auth (SPF/DKIM/DMARC); suppression + consent tables. | **Critical** — a wrong tenancy/secret model here poisons everything; RLS + isolation itest are non-negotiable gates. |
| **P1** | **Reputation isolation + send path** — per-tenant sending domain/pool; single 1:1 queued send; idempotency; suppression gate; delivery/bounce webhook. | **Highest** — first real mail leaves the building; double-send, missed suppression, or shared reputation are all live-fire failures. |
| **P2** | **Templates** — CRUD + versioning + variables/fallbacks + ownership/sharing + render-safety; web Templates tab. | **Medium** — template injection / untrusted eval is the security risk; ownership scoping the data risk. |
| **P3** | **Tracking + Inbox** — full event tracking + per-contact timeline + reply detection + unified inbox + real-time status. | **Medium-high** — webhook signature verification, MPP-aware open handling (**D6**), and reply attribution accuracy. |
| **P4** | **Sequences + automation** — cadences, steps, branching, scheduling, auto-pause-on-reply, throttled enrollment; web Sequences tab. | **High** — automation amplifies every bug; a misfiring scheduler or missed auto-pause sends at scale; needs a confirmed leader-locked scheduler. |
| **P5** | **Deliverability + warmup + analytics** — warmup automation, deliverability dashboard, seed/placement hooks, blacklist monitoring; Deliverability + Analytics tabs; leaderboards. | **Medium** — warmup pacing and placement-signal accuracy; analytics must report reply rate, not inflated opens. |
| **P6** | **Admin + governance** — /admin mailbox/domain mgmt, infra config, per-tenant limits/reputation, global suppression, email-volume billing; compliance/audit; DSAR cascade. | **Medium-high** — staff power over tenant mail + billing correctness + DSAR cascade completeness; privacy-first staff posture. |

## 9. Document index (this doc owns the index)

> All 16 docs in `docs/planning/email-planning/`. Cross-reference siblings by these numbers and names.
> Supporting `ADR-NNNN-email-*.md` files live in `docs/planning/decisions/`.

| Doc | Name | Purpose (one line) |
|-----|------|--------------------|
| `00` | **overview** (this) | Vision, motivation, M12-extends-M9 framing, scope, Locked Decisions D1–D11, vocabulary, current-state base, landscape, metrics, phase map, and the document index. |
| `01` | **templating** | Versioned, owner-scoped, shareable templates; variables + fallbacks; render-safety (no untrusted template eval). |
| `02` | **sending-infrastructure** | The hybrid send path (**D1**): mailbox OAuth/SMTP + ESP relay, idempotency (**D5**), queues (**D10**), secret storage (**D7**). |
| `03` | **deliverability** | SPF/DKIM/DMARC, sending-domain auth, warmup, blacklist/seed monitoring, Google/Yahoo 2024 sender-rule mechanics. |
| `04` | **status-event-tracking** | Open/click/reply/bounce/unsub/complaint/delivery events, per-contact timeline, reply detection, MPP-aware opens (**D6**), custom tracking domain (**D3**). |
| `05` | **sequences-automation** | Cadences, steps, branching, scheduling, auto-pause-on-reply, throttled enrollment, the sequence-tick queue. |
| `06` | **compliance** | Suppression (**D4**), consent/lawful-basis, one-click List-Unsubscribe (RFC 8058), CAN-SPAM, GDPR/DPDP DSAR cascade (**D9**). |
| `07` | **multitenancy-reputation-isolation** | Per-tenant Reputation Pools, no shared sending/tracking domain, the isolation guarantee + itest (**D2**, **D3**) — highest-risk. |
| `08` | **reporting-analytics** | Reply-rate-primary reporting (**D6**), deliverability dashboards, per-mailbox/per-rep leaderboards, analytics. |
| `09` | **data-model** | The canonical email entities, columns, RLS (ENABLE+FORCE, fail-closed `NULLIF`), `tenant_id`-leading indexes, DSAR cascade — **owns the entities**. |
| `10` | **web-surface** | The `apps/web` Email destination: Templates, Sequences, Inbox, Deliverability, Analytics tabs; `@leadwolf/ui`; four states. |
| `11` | **admin-surface** | The `apps/admin` email console: mailbox/domain mgmt, per-tenant limits/reputation, global suppression, email-volume billing, DSAR. |
| `12` | **roles-permissions** | Owner-scoped visibility (**D8**), explicit shares, workspace-role, manager/admin override; the email capability matrix. |
| `13` | **rollout-phases** | The phased roadmap P0–P6 (§8), work units, sequencing, and end-to-end verification recipe — **owns the phase map**. |
| `14` | **current-state-integration** | The authoritative reuse map (**D11**): the shipped M9 tables / core modules / surfaces and exactly how M12 extends each — owns the "build on, don't duplicate" contract. |
| `15` | **scalability-extensibility** | How the subsystem scales (partitioned `email_event`, per-tenant send-quota via the `creditRepository` lock, queue/throttle backpressure) and stays extensible (pluggable `EmailSenderPort` / `ProviderAdapter` registry, `email.*` event bus, channel headroom). |

---

**Sources (current, 2024–2026):**

- [Google: Email sender guidelines (Gmail bulk-sender requirements)](https://support.google.com/a/answer/81126)
- [Mailgun: Yahoogle new bulk sender requirements in 2024](https://www.mailgun.com/state-of-email-deliverability/chapter/yahoogle-bulk-senders/)
- [dmarcian: Yahoo and Google DMARC required](https://dmarcian.com/yahoo-and-google-dmarc-required/)
- [Mailchimp: Apple Mail Privacy Protection (MPP) FAQs](https://mailchimp.com/help/apple-privacy-faq/)
- [beehiiv: Impact of Apple MPP on open rates](https://www.beehiiv.com/blog/apple-mpp-open-rate)
- [Paubox: How Apple Mail Privacy Protection inflates open rates](https://www.paubox.com/blog/how-apple-mail-privacy-protection-inflates-email-open-rates)
- [Apollo: Choosing an outbound platform for email deliverability](https://www.apollo.io/insights/how-do-i-choose-an-outbound-sales-platform-that-prioritizes-email-deliverability)
- [BuzzLead: HubSpot vs Salesloft vs Outreach vs Apollo (2025–2026)](https://buzzlead.io/blogs/hubspot-vs-salesloft-vs-outreach-vs-apollo-honest-sales-engagement-comparison-20)
- [Forecastio: Best sales engagement software 2026](https://forecastio.ai/blog/best-sales-engagement-software)
- [SalesRobot: Apollo vs Salesloft 2025](https://www.salesrobot.co/blogs/apollo-vs-salesloft)
- [Reply.io](https://reply.io/) and [Snov.io: Reply.io review](https://snov.io/blog/reply-io-review/)
- [HubSpot: Understand email sending in HubSpot](https://knowledge.hubspot.com/marketing-email/understand-email-sending-in-hubspot)
- [Sparkle: Smartlead vs Instantly (2026)](https://sparkle.io/blog/smartlead-vs-instantly/)
- [DevCommX: Instantly vs Smartlead vs Lemlist (2026)](https://www.devcommx.com/blogs/instantly-vs-smartlead-vs-lemlist-2026)
- [GrouGlobal: Lemlist vs Smartlead](https://grouglobal.com/blog/lemlist-vs-smartlead)
