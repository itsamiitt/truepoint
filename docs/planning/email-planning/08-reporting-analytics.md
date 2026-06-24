# Email Subsystem — Reporting & Analytics (08)

> **Status:** Plan (not yet built). **Owner:** Platform (aggregation/scale) + Data (the metric
> definitions) + Design (rendering) + Security (response shaping). **Last updated:** 2026-06-24.
> This document specifies **how TruePoint measures and reports on email** end to end: the core
> metrics and their current (2024–2026) industry benchmarks, a per-mailbox/per-domain
> **deliverability health score**, the performance breakdowns (mailbox / sequence / template),
> and team/rep leaderboards. It is the analytics contract that the **Analytics tab** in
> `10-web-surface.md` and the **admin deliverability monitoring** in `11-admin-surface.md`
> render against.
>
> **Anchored on D6:** **reply rate is the primary KPI of record.** Opens are *informational
> only* — Apple Mail Privacy Protection (MPP) inflates them — and are presented with an explicit
> caveat everywhere they appear. **Scoped per D2 (tenant) and D8 (owner):** every number a viewer
> sees is bounded by their tenant, and by their role (rep → own; manager → team; admin →
> workspace), per the role boundaries in `12-roles-permissions.md`.
>
> **Source of truth.** All analytics are *derived* from two canonical fact tables owned by
> `09-data-model.md`: **`email_send`** (one row per dispatched message) and **`email_tracking_event`**
> (opens, clicks, replies, bounces, complaints, unsubscribes). Analytics never invent counts; they
> roll up these facts. Tenancy mechanics (RLS, GUCs, indexes) are owned by `07-multitenancy-reputation-isolation.md`.

---

## 1. Principles (what makes this analytics layer correct)

1. **Reply rate is the KPI of record (D6).** Outbound sales email is judged on whether a human
   replied — not on whether a pixel loaded. Every dashboard leads with reply rate. Opens are kept,
   labelled *informational*, and never used to rank reps, gate sequences, or trigger automation.
2. **Opens are inflated and must carry a caveat (D6).** Apple MPP pre-fetches the tracking pixel on
   email receipt regardless of whether the human opened the message; ~64% of Apple Mail users are on
   MPP and Apple-Mail open rates run near 100%, dragging blended open rates from a true ~15–25% up to
   a reported ~40–60% ([Paubox](https://www.paubox.com/blog/how-apple-mail-privacy-protection-inflates-email-open-rates),
   [beehiiv](https://www.beehiiv.com/blog/apple-mpp-open-rate)). TruePoint **flags MPP-attributed
   opens** at ingestion (`04-status-event-tracking.md`) and always renders an **"MPP-inflated —
   informational only"** caveat next to any open metric.
3. **Every metric is derived from facts, never stored as a guess.** A rate is `numerator /
   denominator` over `email_send` + `email_tracking_event` rows the viewer is allowed to see. No
   "open count" is ever written as a free-floating column that can drift from the events.
4. **Analytics are tenant-scoped (D2) and owner-scoped (D8) — at the database, not the UI.** A rep
   querying "reply rate" gets a number computed over *only their own sends*. Response shaping
   (security's mandate) means the same endpoint returns different rows and different fields to a rep,
   a manager, and a tenant-admin. UI hiding is never the boundary.
5. **Aggregation is a platform concern.** At sales-engagement volume (millions of sends per tenant)
   a dashboard cannot scan `email_send` on every page load. We pre-aggregate into **rollup tables**
   via queued jobs and serve dashboards from rollups; raw-fact queries are reserved for narrow,
   bounded drill-downs (§5).
6. **Large result sets are cursor-paginated and virtualized.** Leaderboards, per-message logs, and
   breakdown tables use **cursor pagination (never offset)** with a server-max limit and are
   **virtualized** in the UI (`@leadwolf/ui`) — the design constraint for large tables.

---

## 2. Core metrics + current (2024–2026) industry benchmarks

The six metrics every sales-email platform reports, their precise TruePoint definition (numerator /
denominator over the fact tables), the **current 2024–2026 sales-email benchmark**, and a
**reliability caveat**. These are the canonical definitions the Analytics tab and admin surface
must use verbatim — a "reply rate" must mean the same thing on every screen.

### 2.1 The metrics table

| Metric | Definition (TruePoint) | 2024–2026 benchmark (sales/cold email) | Caveat / reliability |
|---|---|---|---|
| **Reply rate** *(PRIMARY KPI — D6)* | distinct `email_enrollment`/thread with a `reply` `email_tracking_event` ÷ `email_send` delivered | **Avg ≈ 3–9%**; **good ≈ 5–10%** (B2B); **top-quartile ≈ 8–12%**; **best-in-class 15%+** on tight segments ([Instantly](https://instantly.ai/blog/cold-email-reply-rate-benchmarks/), [Built For B2B](https://www.builtforb2b.com/blog/b2b-cold-email-benchmark-2025), [Belkins](https://belkins.io/blog/cold-email-response-rates)) | **Most reliable engagement signal.** Reply requires a human action MPP cannot fake. The KPI of record. Watch for auto-replies/OOO — classify and exclude (`04`). |
| **Open rate** *(informational only — D6)* | distinct opened `email_send` (an `open` event) ÷ `email_send` delivered | **Reported ≈ 40–60%**; **true human ≈ 15–25%** ([beehiiv](https://www.beehiiv.com/blog/apple-mpp-open-rate), [Paubox](https://www.paubox.com/blog/how-apple-mail-privacy-protection-inflates-email-open-rates)) | **MPP-INFLATED — DO NOT use as KPI.** ~64% of Apple Mail users pre-fetch the pixel; Apple-Mail opens ≈100%. Always shown with the MPP caveat; never ranks reps or gates automation. |
| **Click rate (CTR)** | distinct `email_send` with a `click` event ÷ `email_send` delivered | **≈ 2–5%** typical for B2B/cold; varies by CTA presence | **More reliable than opens** — MPP does not auto-click links — but tracking-link rewriting can be stripped/blocked; treat as a secondary signal. |
| **Bounce rate** | `email_send` with a `bounce` event (hard + soft) ÷ `email_send` attempted | **Target < 2%**, **ideal < 1%**; senders under **1.5%** see **10–12% higher inbox placement** ([MailReach](https://www.mailreach.co/blog/email-deliverability-statistics)) | **Highly reliable** (provider-reported). Split **hard vs soft** — hard bounces auto-add to `email_suppression` (D4). A deliverability KPI, not engagement. |
| **Unsubscribe rate** | `unsubscribe` events (incl. one-click `List-Unsubscribe`) ÷ `email_send` delivered | **B2B ≈ 0.04–0.06%**; **best practice < 0.1%**; **critical > 0.3%**; cold-email avg ≈ **0.17%** ([Validity 2025](https://www.validity.com/wp-content/uploads/2025/03/2025-Benchmark-Report-FINAL.pdf), search corpus) | **Reliable.** Every unsubscribe writes `email_consent`/`email_suppression` and gates future sends (D4, `06-compliance.md`). |
| **Complaint (spam) rate** | `complaint` events (FBL/ARF) ÷ `email_send` delivered | **Keep < 0.1%** (recommended); **Gmail policy violation > 0.3%**; Google added threshold lines (recommended **0.10%**, violation **>0.30%**); Microsoft tightened in 2025 ([Suped](https://www.suped.com/learn/email-deliverability/how-accurate-is-snds-and-google-postmaster-tools-reputation-data), [data-axle](https://www.data-axle.com/resources/blog/bulk-sender-requirements-how-to-stay-compliant/)) | **The most dangerous metric.** Crossing 0.3% at Gmail tanks placement. Complaint auto-suppresses the recipient (D4) and is the heaviest negative input to the health score (§3). |

> **Reading the benchmarks.** Sales-email benchmarks span a wide range by source, ICP, and
> list quality; we cite ranges, not false-precision points. The values above are the
> defensible 2024–2026 consensus and are what the UI shows as the "industry band" behind a
> tenant's own number. Reply-rate top-quartile is **≈ 8–12%** and best-in-class **15%+**
> ([Instantly](https://instantly.ai/blog/cold-email-reply-rate-benchmarks/),
> [Built For B2B](https://www.builtforb2b.com/blog/b2b-cold-email-benchmark-2025)).

### 2.2 Derived/secondary metrics

- **Delivery rate** = delivered ÷ attempted (the inverse of bounce); inbox-placement consensus is
  **>89% excellent, 83–88% acceptable, <83% problem** ([Validity](https://www.validity.com/wp-content/uploads/2025/03/2025-Benchmark-Report-FINAL.pdf)).
- **Reply-to-positive rate** (optional) — replies classified positive ÷ delivered; requires reply
  classification (out of scope for v1, noted for later).
- **Meeting/booking rate** — downstream conversion, ≈ **0.8%** (≈1 in 100) per the cold-email corpus;
  only computable once CRM/calendar signals are wired (not v1).
- **Click-to-open rate (CTOR)** — *deliberately de-emphasized*: its denominator (opens) is
  MPP-poisoned, so CTOR is doubly unreliable and is shown only behind the open caveat, if at all.

---

## 3. Deliverability health score (composite, per mailbox / per domain)

A single **0–100 health score** per `mailbox_integration` and per `sending_domain`, so a rep sees
"is my mailbox healthy?" at a glance and an admin sees the workspace's posture in
`11-admin-surface.md`. It composes the deliverability metrics (§2) plus external reputation signals
into one number with a **High / Medium / Low** band.

### 3.1 Best-in-class approach (what the industry does)

- **Validity Sender Score** — a 0–100 IP reputation rank computed on a **rolling 30-day** window
  from complaint rates, spam-trap hits, volume, and engagement; **>80 good, 70–80 acceptable, <70
  problem** ([Instantly](https://instantly.ai/blog/sender-score/), [Validity](https://senderscore.org/)).
- **Google Postmaster Tools (GPT)** — domain/IP signals, spam-rate dashboard with explicit threshold
  lines (**recommended 0.10%, policy violation >0.30%**), and authentication/compliance status (SPF,
  DKIM, DMARC, PTR, TLS, one-click unsubscribe). *Note:* GPT v1 reputation dashboards were retired
  Sept 30 2025; the **spam-rate and compliance** signals remain
  ([Suped](https://www.suped.com/blog/google-postmaster-tools-domain-reputation-and-ip-reputation-have-been-discontinued),
  [data-axle](https://www.data-axle.com/resources/blog/bulk-sender-requirements-how-to-stay-compliant/)).
- **Microsoft SNDS** — IP-level color bands (green = spam verdict <10% of the time; yellow = middle;
  red = dominated) ([Suped](https://www.suped.com/learn/email-deliverability/what-is-microsofts-equivalent-to-google-postmaster-tools-for-deliverability-monitoring)).
- Modern engagement platforms (Instantly/Smartlead/MailReach) fold inbox-placement seed tests,
  authentication status, and warmup state into a single "health" number.

### 3.2 Recommended TruePoint approach

A **weighted composite** computed by a queued rollup job (§4) and stored as a small per-entity score
row, refreshed on a rolling window. The inputs and indicative weights:

| Input | Source | Direction | Weight (indicative) |
|---|---|---|---|
| **Complaint rate** (§2) | `email_tracking_event` | lower better; **>0.3% = automatic Low** | heaviest negative |
| **Bounce rate** (§2) | `email_send` + events | lower better; >2% penalised | high |
| **Reply rate** (§2, D6) | events | higher better (positive engagement) | medium-positive |
| **Authentication posture** | `sending_domain` (SPF/DKIM/DMARC alignment, PTR, TLS, one-click unsub) | pass/fail gates | gating |
| **Warmup state** | `mailbox_integration` warmup status (`02-sending-infrastructure.md`) | a mailbox still warming caps the score | gating |
| **Volume vs. ramp** | `email_send` rate vs. allowed ramp | spikes penalised | medium |
| **External reputation** (optional, where wired) | GPT spam-rate / SNDS band / Sender Score | aligns with provider verdict | medium |

- **Bands:** **High ≥ 80**, **Medium 60–79**, **Low < 60** — and any **complaint rate > 0.3% forces
  Low** regardless of the rest (mirrors the Gmail policy line). A failing auth posture or a
  not-yet-warmed mailbox **caps** the score at Medium.
- **Window:** rolling 30-day (matching Sender Score), with a 7-day sub-score surfaced as a "trend"
  arrow so a sudden deterioration is visible before the 30-day number moves.
- **Per-tenant only (D2).** Because reputation is isolated per tenant (D2) and tracking domains are
  per-tenant (D3), the health score is **never blended across tenants** — a tenant's score reflects
  only its own pools.

### 3.3 Tradeoffs

- **Composite simplicity vs. nuance.** One number is legible and actionable but hides *why*. We
  mitigate by always drilling from the score to its component metrics (§2) and to the offending
  mailbox/domain.
- **Internal-only vs. external-signal blend.** Internal-only (events) is always available, fully
  owned, and immediate; blending GPT/SNDS/Sender Score is more authoritative but those feeds are
  rate-limited, partial (consumer mailboxes only), and GPT reputation dashboards were retired in
  2025 — so external signals are **enrichment, not the spine**. The score must remain meaningful
  from internal events alone.
- **Weights drift.** Hard-coded weights age; we treat the weight table as a tunable config
  (admin-visible) rather than a magic constant, and pin the version of the scoring formula on each
  stored score so historical scores remain interpretable.

---

## 4. Aggregation strategy (how the numbers are computed at scale)

This is the platform-owned core. The question is **pre-aggregated rollups vs. on-the-fly query**.

### 4.1 The two strategies and their tradeoffs

| Strategy | How | Pros | Cons | TruePoint use |
|---|---|---|---|---|
| **On-the-fly query** | `COUNT`/`SUM`/`FILTER` over `email_send` + `email_tracking_event` at read time | always exact, no extra storage, simple | scans grow with volume; a multi-million-row tenant makes a dashboard page slow; heavy DB load under fan-out | **drill-downs only** — narrow, bounded (single sequence/template/mailbox, recent window) |
| **Pre-aggregated rollups** | scheduled/triggered jobs write per-bucket counters into rollup tables; dashboards read rollups | fast, cheap reads; predictable load; supports large date ranges | eventual (lag of one job cycle); extra tables; must handle late/out-of-order events and backfills | **default** for all dashboards, leaderboards, health scores |

### 4.2 Recommended: rollups by default, on-the-fly for narrow drill-downs

- **Time-bucketing.** Roll up counts (sends, delivered, opens, clicks, replies, bounces, unsubs,
  complaints) into **hourly** and **daily** buckets, keyed by the dimensions we slice on:
  `tenant_id` + `workspace_id` + `owner_user_id` + (`mailbox_integration` | `email_sequence` |
  `email_template_version` | `sending_domain`). Hourly buckets are rolled up into daily; daily into
  the rolling-window aggregates that feed the health score (§3). A dashboard for "last 30 days by
  rep" reads ~30 daily rows per rep, not millions of fact rows.
- **Materialized counters.** Per-entity running counters (e.g. lifetime sends/replies per sequence)
  are maintained incrementally so a "sequence card" renders without scanning. Counters are
  **derived and rebuildable** from the fact tables — never the source of truth — so a backfill job
  can recompute them if they drift.
- **Late & out-of-order events.** Tracking events (opens, replies, bounces) arrive after the send,
  sometimes days later (`04`). Rollup jobs are **idempotent** and re-process a trailing window
  (e.g. last 72h) so late events land in the right bucket; counters are adjusted, not double-counted
  (keyed on the event's identity).
- **Queue-backed (D10).** Rollup and health-score computation run as **BullMQ jobs**
  (`apps/workers/src/queues/email*.ts`) with **backoff + DLQ** and **backpressure**, so analytics
  load never competes with the send path. Per the known-gaps note, the scheduler must be
  **leader-locked** so a bucket is computed once, not per worker.
- **Idempotency & isolation.** Jobs set the tenant GUC and run inside the tenant RLS boundary
  (`07`); a rollup job reads and writes only its tenant's rows. The aggregation code lives in
  `packages/core/src/email/` and the rollup tables alongside the fact tables in
  `packages/db/src/schema/email.ts` with **`tenant_id`-leading indexes**.

### 4.3 Read path & rendering (design constraints)

- Dashboard reads go through `apps/api/src/features/email/{routes.ts,index.ts}` analytics endpoints
  under `/api/v1`, validated by Zod in `@leadwolf/types`, returning the **RFC 9457** envelope on
  error.
- **Cursor pagination, never offset**, with a server-max limit on every list-shaped response
  (leaderboards, breakdown tables, per-message drill-down logs).
- The Analytics tab **virtualizes** large tables (`@leadwolf/ui`) and renders the **four states via
  `StateSwitch`** (loading / empty / error / data), uses `var(--tp-*)` tokens, is **WCAG 2.2 AA**,
  i18n-ready, light-theme only — per `10-web-surface.md` and the design constraints.
- **Caching.** Rollup reads are cacheable (short TTL keyed by tenant + dimension + window) because
  they already lag by a job cycle; cache keys are **tenant-scoped** so no cross-tenant bleed.

---

## 5. Performance breakdowns (mailbox / sequence / template)

Three first-class breakdown views, all reading rollups (§4), all owner-/tenant-scoped (§6), all
leading with reply rate (D6) and tagging opens with the MPP caveat.

| Breakdown | Keyed by | Headline metric (D6) | Also shows | Drill-down |
|---|---|---|---|---|
| **Per-mailbox** | `mailbox_integration` | reply rate | sends, delivery/bounce, complaint, **health score (§3)**, warmup state | → per-message log (cursor-paginated) for that mailbox |
| **Per-sequence** | `email_sequence` (+ per-`email_sequence_step`) | reply rate per sequence and **per step** | enrolled/active/completed, sends, bounce, unsub, step drop-off funnel | → which step kills replies; which step bleeds unsubs |
| **Per-template** | `email_template` / `email_template_version` | reply rate per **version** | click rate, open (caveated), sends; A/B compare of versions | → version-over-version lift; pick the winner |

- **Per-step funnel.** A sequence breakdown shows enrolled → step-1 sent → replied/bounced/unsub at
  each step, so a rep sees *where* a sequence loses people. Reply rate is computed per step over
  that step's sends.
- **Template versioning.** Because templates are versioned (`email_template_version`, owned by `09`),
  performance is attributed to the **version that was sent**, enabling honest A/B comparison; editing
  a template never rewrites the history of the prior version's sends.
- **Tradeoff — dimension explosion.** Rolling up by every combination (mailbox × sequence × template
  × step × day) is combinatorially large. We roll up the **single-dimension** slices that dashboards
  need by default and compute rarer cross-dimension cuts **on-the-fly** within a bounded window
  (§4.1), rather than materializing every cross-product.

---

## 6. Owner-scoped & tenant-scoped visibility (D8, D2) — who sees which numbers

Analytics visibility is the same owner-scope model as the rest of TruePoint (D8), enforced at the
database (RLS, `07`) **and** by response shaping (security's mandate, `12-roles-permissions.md`).
The role names and exact boundaries are owned by `12`; this section states what each tier sees of
**analytics**.

| Viewer (per `12`) | Scope of every analytics number | Leaderboards | Health score (§3) | Enforced by |
|---|---|---|---|---|
| **Rep** (workspace member) | **own** sends only (`owner_user_id = self`) | sees **own rank**, not peers' raw numbers | own mailboxes | RLS owner predicate + app-filter; same endpoint, shaped response |
| **Manager** (team lead) | **the team** they manage (a defined set of reps) | full team leaderboard | team mailboxes/domains | RLS workspace + manager-team filter |
| **Tenant-admin** | **the whole workspace** | workspace-wide | all mailboxes/domains in workspace | RLS workspace predicate |
| **Platform staff** | **aggregate only, no row-level PII** (per `list-plan/07` governance posture) | — | system/abuse signals | `withPlatformTx` bounded/shaped; no per-recipient PII |

- **Same endpoint, different result (response shaping).** A rep and a manager hit the same
  `/api/v1` analytics route; the **rows returned and the fields shaped** differ by role. A rep can
  never widen scope by passing another rep's id — the id from the client is **never trusted**; an
  out-of-scope id resolves to **404 (IDOR → 404)**, not 403.
- **Tenant isolation is absolute (D2).** No analytics number, benchmark band, or leaderboard ever
  spans tenants. Reputation isolation (D2) means even the health score is per-tenant.
- **No PII in aggregates.** Analytics are counts and rates. A complaint or unsubscribe is counted;
  the recipient's PII is not surfaced in a dashboard. Drill-down to a per-message log is itself
  owner-/role-scoped and audited (audit records **IDs + action only**, no PII in logs).

---

## 7. Team & rep leaderboards

Leaderboards make reply rate (D6) the competitive surface, while protecting the integrity of the
ranking and the visibility rules of §6.

### 7.1 Best-in-class approach

Outreach/Salesloft-style team analytics rank reps by **reply/response and meetings booked**, not by
opens — precisely because opens are MPP-noise. Activity volume (sends) is shown alongside outcome so
"high volume, low reply" is visible.

### 7.2 Recommended TruePoint approach

- **Rank by reply rate (D6)**, with **minimum-volume gating** so a rep with 3 sends and 1 reply
  (33%) doesn't top a rep with 500 sends and 8% — a leaderboard requires a minimum denominator
  before a rate is ranked, otherwise it sorts by raw replies.
- **Columns:** reply rate (primary), replies, sends, delivery/bounce, complaint, unsubscribe; opens
  shown only behind the **MPP caveat** and **never the sort key by default**.
- **Scope per §6/D8:** a rep sees their own rank and the team band (their position), a manager sees
  full per-rep rows for their team, an admin sees the workspace. Cross-rep raw numbers are shaped
  out for a plain rep.
- **Time windows:** selectable (7/30/90-day, this-quarter) — all served from the daily rollups (§4),
  so a 90-day leaderboard is a small rollup read, not a fact-table scan.
- **Cursor-paginated + virtualized.** A large workspace's leaderboard pages via cursor and
  virtualizes rows; never offset pagination, never a full client-side load.

### 7.3 Tradeoffs

- **Gaming & vanity.** Ranking on rate invites tiny-denominator gaming (mitigated by min-volume);
  ranking on raw replies favours high-volume spammers (mitigated by showing complaint/bounce
  alongside). Showing **both** outcome and quality is the balance.
- **Morale vs. transparency.** Public per-rep leaderboards motivate but can demoralise; the owner-
  scope model (§6) lets a tenant decide whether reps see peers' raw numbers or only their own band.
- **Latency vs. freshness.** Leaderboards read rollups, so they lag by a job cycle (minutes). For a
  sales contest this is acceptable; we surface "as of HH:MM" so the lag is honest, never implied as
  real-time.

---

## 8. Cross-references

- **`04-status-event-tracking.md`** — the source of `email_tracking_event`, including MPP open
  flagging, reply/auto-reply classification, and bounce/complaint ingestion (the raw material).
- **`07-multitenancy-reputation-isolation.md`** — tenancy mechanics (RLS ENABLE+FORCE, fail-closed
  NULLIF, GUCs, `tenant_id`-leading indexes) and per-tenant reputation isolation (D2) that make
  analytics tenant-scoped.
- **`09-data-model.md`** — owns `email_send`, `email_tracking_event`, the rollup/counter tables, and
  the versioned `email_template_version` that template analytics attribute to.
- **`10-web-surface.md`** — the **Analytics tab** in `apps/web/src/features/email/` that renders
  §2–§7 (four states, virtualization, cursor pagination, MPP caveats).
- **`11-admin-surface.md`** — admin **deliverability monitoring**: the health score (§3) across
  mailboxes/domains, complaint/bounce watch, and abuse signals.
- **`12-roles-permissions.md`** — the authoritative role boundaries that §6 visibility derives from.
- **`13-rollout-phases.md`** — analytics dashboards + leaderboards land in **Phase 5 (P5)**
  alongside deliverability + warmup; the fact tables (`email_send`, `email_tracking_event`) precede
  them from the send path (P1) and tracking (P3).

---

## 9. Self-check (D6 & scope conformance)

- ✅ **Reply rate is the primary KPI** in every table, breakdown, and leaderboard (§2, §5, §7); opens
  are **informational only** and carry the **MPP caveat** everywhere (§1.2, §2.1, §7.2) — **D6**.
- ✅ **Owner-scoped (D8):** rep → own, manager → team, admin → workspace, per `12` (§6); enforced by
  RLS + response shaping; **IDOR → 404**.
- ✅ **Tenant-scoped (D2):** no number or leaderboard spans tenants; health score per-tenant.
- ✅ **Derived from `email_send` + `email_tracking_event`** (`09`); aggregation tradeoffs covered —
  rollups vs on-the-fly, materialized counters, time-bucketing, late-event handling, queue-backed
  (§4).
- ✅ **Large-data rendering:** cursor pagination (never offset) + virtualization (§4.3, §7.2).
- ✅ **Benchmark table present** with 2024–2026 numbers and caveats (§2.1); **≥3 live sources** cited
  inline (Instantly, Built For B2B, Belkins, MailReach, Validity, Paubox, beehiiv, Suped, data-axle).
