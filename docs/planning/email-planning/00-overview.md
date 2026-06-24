# Email Subsystem — Overview & Decisions (00)

> **Status:** Plan (not yet built). **Owner:** Product + Platform. **Last updated:** 2026-06-24.
> This is the **anchor / spine** document for the `docs/planning/email-planning/` set, mirroring the
> shipped `docs/planning/list-plan/` set. The **Locked Decisions (D1–D10)**, **Shared Vocabulary**,
> **Canonical Entities**, and **Phase Map (P0–P6)** below are canonical — every other doc in this folder
> cites them verbatim and **must not contradict them**. This doc **owns the document index** in §9.

---

## 1. Why we're building this

TruePoint already lets a workspace **find and own a book of prospects** (the Prospect surface, the List
tab + import/enrichment, and the Sequences hooks the List tab hands off to). What it does **not** yet have
is the layer that turns an owned, enriched list into **revenue motion**: the ability to actually *reach*
those people, at scale, from real inboxes, and measure what comes back. **There is no email subsystem
today.**

The email engine is the **natural layer atop Lists + Sequences**. A seller's job does not end at "I have
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

The email subsystem does seven things. Each is owned in depth by a sibling doc (§9).

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

### In scope (this plan set)

- **Mailbox-based 1:1 and automated sending** from connected Google/Microsoft (OAuth) and SMTP identities,
  with a relay/transactional ESP backbone for platform/system mail (per **D1**).
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

## 3. Locked decisions (D1–D10 — canonical; cite by ID, never contradict)

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
  `02`, entity `email_idempotency_key`).
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

## 4. Shared vocabulary (canonical)

> These exact terms and entity names are used verbatim across all 14 docs. Entities are **owned by doc
> `09`** (§9); this glossary defines them in plain English.

- **Mailbox** — a connected **sending identity** (Google/Microsoft OAuth, or SMTP/ESP), owned by a user
  within a workspace. Entity: **`mailbox_integration`**.
- **Sending Domain** — a **tenant-owned domain or subdomain** authenticated for sending (SPF/DKIM/DMARC).
  Entity: **`sending_domain`**.
- **Template** — a reusable, **versioned** artifact (subject + body + variables), owner-scoped and
  shareable. Entities: **`email_template`** / **`email_template_version`**.
- **Sequence (Cadence)** — an **ordered, multi-step automated outreach** flow. Entities:
  **`email_sequence`** → **`email_sequence_step`**.
- **Enrollment** — a **Person enrolled into a Sequence**. Entity: **`email_enrollment`**.
- **Send** — a **single outbound email record** (references a Person, Template, Mailbox, and optionally a
  Sequence step). Entity: **`email_send`**.
- **Tracking Event** — an **open / click / reply / bounce / unsub / complaint / delivery** record tied to a
  Send. Entity: **`email_tracking_event`**.
- **Suppression** — an address/Person **blocked from sends** (unsubscribe, hard-bounce, complaint, manual,
  DNC); **tenant + workspace scoped**. Entity: **`email_suppression`**.
- **Consent** — a recorded **lawful basis / opt state**. Entity: **`email_consent`**.
- **Reputation Pool** — the **isolation unit for sending reputation**: a per-tenant sending domain +
  mailbox set (+ optional dedicated IP).
- **Warmup** — the **gradual volume ramp** of a new mailbox / domain / IP.

## 5. What we build on (existing TruePoint infrastructure, reused)

The email subsystem is **new** (there is no email schema, surface, worker, or core module today), but it is
**not greenfield infrastructure** — it sits on the same platform every other TruePoint subsystem uses, and
must cite (not re-derive) the **TruePoint constraints digest**:

- **Tenancy / RLS** — `tenant_id` + `workspace_id` on every row; Postgres **RLS ENABLE + FORCE,
  fail-closed `NULLIF`**, transaction-local GUCs (`SET LOCAL`), `tenant_id`-leading composite indexes.
  Workers set tenant context per job (**D10**). RLS lives at `packages/db/src/rls/email.sql`; the email
  schema at `packages/db/src/schema/email.ts`; the **sole data-access layer** is
  `packages/db/src/repositories/emailRepository.ts`.
- **API contract** — Hono on Bun under **`/api/v1`**; **Zod schemas in `@leadwolf/types`** as single source
  of truth; **cursor (never offset) pagination** with a server-max limit; **Idempotency-Key on billable
  creates** (every send — **D5**); **RFC 9457 `application/problem+json`** errors (machine code, no
  PII/stack); per-user + per-tenant rate limits with `Retry-After`. Routes at
  `apps/api/src/features/email/{routes.ts,index.ts}`.
- **Queues** — **BullMQ/Redis**, named purpose queues (**D10**), idempotent at-least-once, backoff + DLQ,
  backpressure-bounded fan-out, user-visible job states + progress. Workers at
  `apps/workers/src/queues/email*.ts`.
- **Design system** — **`@leadwolf/ui`** components only; **`var(--tp-*)`** tokens (no hardcoded hex/px);
  four states via `StateSwitch` (loading/empty/error/data); virtualized large tables + cursor pagination;
  **WCAG 2.2 AA**; i18n; light theme only. Web feature at `apps/web/src/features/email/`.
- **Ownership model** — owner-scope + explicit sharing + workspace-role (**D8**); **references, not copies**
  (an `email_send` references the canonical Person/Template, never copies them); dedup/uniqueness
  constraints.
- **Audit** — append-only audit storing **IDs + actions, NEVER PII or message bodies** — the same posture
  the List tab's `platform_audit_log` uses.
- **DSAR** — the existing DSAR cascade pattern (find all tenant references for a Person, soft+hard delete
  per retention) extended to suppress + dis-enroll across email entities (**D9**, doc `06`).
- **Pure domain logic** — render, scheduling, and compliance rules live in `packages/core/src/email/`,
  framework-free.

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

> All 14 docs in `docs/planning/email-planning/`. Cross-reference siblings by these numbers and names.
> Supporting `ADR-NNNN-email-*.md` files live in `docs/planning/decisions/`.

| Doc | Name | Purpose (one line) |
|-----|------|--------------------|
| `00` | **overview** (this) | Vision, motivation, scope, Locked Decisions D1–D10, vocabulary, landscape, metrics, phase map, and the document index. |
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
