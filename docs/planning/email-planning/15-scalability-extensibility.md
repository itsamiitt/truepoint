# Email Subsystem — Scalability & Extensibility (15)

> **Status:** Plan (not yet built). **Owner:** Platform + Operations (Part A) + Architecture + Data (Part B).
> **Last updated:** 2026-06-24.
> This is the **forward-looking** doc of the `docs/planning/email-planning/` set. It cites the **Locked
> Decisions (D1–D11)**, **Shared Vocabulary**, and **Canonical Entities** in `00-overview.md`, the **Phase
> Map (P0–P6)** owned by `13-rollout-phases.md`, the **roles/permissions matrix** in `12-roles-permissions.md`,
> and **doc `14`** for the operational SLO/observability detail it leans on. It owns two questions and only
> two: **(A) how this subsystem holds up under load** and **(B) where it is designed to grow** — the
> extensibility seams that exist *because* the design left room, not as future rework.
>
> **D11 is load-bearing for this entire doc.** The email subsystem **extends the shipped M9 outreach engine**
> — it reuses `outreach_sequences` / `outreach_steps` / `outreach_log` (sequence / step / enrollment),
> `activities` (engagement timeline), `suppression_list` + `assertNotSuppressed` (the D4 gate),
> `consent_records` (D9), `idempotency_keys` (D5), `audit_log`, the `creditRepository` lock pattern (for the
> new send-quota), and the `EmailSenderPort` seam (for real sending). It **does not** introduce parallel
> `email_sequence` / `email_sequence_step` / `email_enrollment` / `email_suppression` / `email_consent` /
> `email_idempotency_key` tables. The genuinely **new** build is: `sending_domain`, `mailbox_integration`, the
> high-volume **partitioned** raw tracking-event store **`email_event`** (which *feeds* `activities`), the
> per-tenant **send-quota** counter (built on the `creditRepository` `SELECT … FOR UPDATE` pattern), warmup,
> and reputation pools. This is **milestone M12 (extend M9)**, not a greenfield build.
>
> **No code** — entity, column, queue, endpoint, header, flag, and config names only. This is a contract:
> where it names a scale gate or an extensibility seam, that gate/seam is part of the cited phase's "Done
> when" (`13`), not a "later" aspiration.

---

## Part A — Scalability

The send path that ships in M9/M12 is correct but **not yet hot-path-hardened**. Part A names, control by
control, where naïve correctness becomes a contention or backlog problem at volume, and what the design must
do instead. The organizing rule: **never put a hot, high-frequency counter on a single DB row that every
worker contends for** — the `creditRepository` `SELECT … FOR UPDATE` pattern is exactly right for the
**low-frequency, money-correct** send-quota (§A.6) and exactly wrong for a **per-second per-mailbox
throttle** (§A.1). The two must not be conflated.

### A.1 Per-mailbox send throttle — Redis counter + queue-local batch cache, never a hot DB row

**What it is.** Every mailbox (`mailbox_integration`) and every Reputation Pool (D2) has a max send rate
(per-minute / per-hour / per-day) that the `outreach.ts` worker (`apps/workers/src/queues/outreach.ts`,
`processOutreach` → `sendStep`) must respect **before** it calls `EmailSenderPort.send`. Per **D10**,
per-tenant and per-mailbox throttling lives **in-queue**, not in a request handler.

**Why a DB row is wrong.** A per-mailbox throttle is checked and decremented on **every single send** — the
highest-frequency write in the subsystem. Modelling it as a row updated under `SELECT … FOR UPDATE` (the
`creditRepository` pattern) would serialize every send for a mailbox through one row lock and make that row a
contention hot-spot the moment a sequence fans out. That pattern is reserved for the send-quota (§A.6), which
is money-correct and low-frequency; the throttle is high-frequency and tolerates approximate correctness.

**The design.**
- **Redis counter, fixed-window or token-bucket, keyed `throttle:{tenant_id}:{mailbox_id}:{window}`.** An
  atomic `INCR` + first-write `EXPIRE` (or a token-bucket Lua script) is the rate decision; Redis is the
  single source of truth for "may this mailbox send right now", co-located with BullMQ (D10) so there is no
  cross-store round-trip on the hot path.
- **Queue-local batch cache.** A worker that has been granted, say, the next 50 sends for a mailbox holds a
  small **in-process lease** and decrements it locally, refilling from Redis only when the lease is exhausted
  — so a burst of 50 sends costs **one** Redis round-trip, not 50. The lease is bounded and short-TTL'd so a
  crashed worker cannot hoard capacity.
- **Backpressure on exhaustion.** When the window is exhausted the job is **re-scheduled** (BullMQ delayed
  re-enqueue), never dropped — the throttle defers, it does not lose mail.

**Contract.** The throttle is a Redis + queue-local concern; **no per-mailbox or per-pool throttle counter is
ever a Postgres row.** A throttle miss reschedules; it never drops or double-sends (idempotency, D5, is the
backstop if a reschedule races).

### A.2 The raw `email_event` store — range-partitioned by day, with retention and ingestion SLOs

**What it is.** `email_event` is the genuinely-new (D11), high-volume raw tracking-event store: every
open / click / reply / bounce / unsubscribe / complaint / delivery webhook lands here first (signed,
idempotent — `04 §6`), and the ingestion worker then **projects** the meaningful ones into `activities`
(`email_sent` / `email_opened` / `email_clicked` / `email_replied`, per `activity.ts`) and into
`outreach_log` status transitions. `email_event` is the firehose; `activities` is the curated timeline. They
are **separate by design** — the firehose must never bloat the timeline table the product reads on every
record-detail render.

**Why partition.** A single unpartitioned `email_event` table is the classic email-platform failure: it grows
without bound, its `tenant_id`-leading indexes bloat, autovacuum falls behind, and retention deletes become
table-locking `DELETE` storms. **Range-partition `email_event` by day** (PostgreSQL declarative
range-partitioning on the provider event timestamp).

**What partitioning buys.**
- **Retention is a `DROP`/`DETACH`, not a `DELETE`.** Per-tenant retention windows (`06`) are enforced by
  detaching/dropping whole day partitions past the window — O(1), no row-by-row delete, no vacuum debt.
- **Hot/cold separation.** Recent partitions (last N days) carry the read traffic for live status (`04 §8`);
  old partitions are read rarely and can move to cheaper storage or be exported (§B.6) before drop.
- **Indexes stay small.** Each partition's `tenant_id`-leading index is bounded by a day's volume, so writes
  stay fast as total history grows.

**Ingestion SLOs (per-phase, by partition volume).**

| Phase | `email_event` ingestion target | Partition / retention posture |
|---|---|---|
| **P3** (tracking ships, `13`) | **< 1M events/day**, edge returns `2xx` fast (`04 §6.1`), webhook→`activities` projection within the doc `14` tracking-ingest latency SLO. | Daily partitions; default retention window; manual partition pre-creation acceptable. |
| **P5** (analytics + volume, `13`) | **< 10M events/day** with **no ingestion backlog** and **no hot-row contention** (the §A.7 load-test gate). | Daily partitions auto-created ahead of time; retention drop automated; rollups (§A.3) absorb read load so `email_event` itself is write-mostly. |

**Contract.** `email_event` is range-partitioned by day from the phase it ships (P3). It **feeds**
`activities` (D11) — it does not replace it, and the product never queries the raw firehose for a timeline
render. Retention is partition `DROP`/`DETACH`, never a `DELETE` scan.

### A.3 Analytics rollups — range-partitioned by hour/day, never live-aggregated over `email_event`

**What it is.** The reply-rate-primary analytics and leaderboards (`08`, D6) must **never** run live
aggregates over the raw `email_event` firehose at read time — a dashboard that `COUNT(*)`s 10M rows on every
load is a self-inflicted outage. Instead, the P5 rollup worker pre-aggregates into **rollup tables**
(per-mailbox / per-sequence / per-rep counts of sent / delivered / replied / clicked / bounced / complaint)
**range-partitioned by hour and day**.

**The design.**
- **Hourly rollups** (range-partitioned by hour) feed near-real-time dashboards; **daily rollups**
  (range-partitioned by day) feed leaderboards and trend views.
- Rollups are **owner-scoped aggregates** (D8) — a rollup row never mixes tenants, and a leaderboard query is
  `tenant_id`-leading and workspace-scoped; the cross-tenant isolation itest (`13 §7`) extends to rollup
  tables.
- Rollups are **idempotently rebuildable** from the retained `email_event` partitions, so a rollup bug is
  recoverable by replay (within retention) rather than being a permanent data loss.

**Contract.** Analytics read rollups, never the firehose. Rollups are partitioned (hour/day), tenant-scoped,
and rebuildable. Reply rate stays the headline (D6); opens stay informational in every rollup that surfaces
them.

### A.4 The `email_sequence_tick` scheduler — leader lock, tick frequency, `FOR UPDATE SKIP LOCKED` batch cap, no-double-advance itest

**What it is.** The cadence scheduler (the D10 `email_sequence_tick` queue) wakes on a fixed cadence, finds
`outreach_log` enrollments whose next step is due, and enqueues each due step onto the send path
(`sendStep`). This is the **single most dangerous worker in the subsystem**: a double-fire is a duplicate
email to a real recipient (`13 §9`, known-gap #5).

**The design.**
- **Single-fire via a leader lock.** Exactly one tick instance does the due-scan per cadence — implemented as
  a **Redis leader election** (a short-TTL lock the active instance renews) **or** a **BullMQ repeatable job
  with a stable `jobId`** so the queue itself guarantees one scheduled instance. Either is acceptable; the
  *contract* is single-fire, not the mechanism.
- **Tick frequency.** A bounded cadence (e.g. once per minute) — frequent enough that a step due "now" fires
  within the product's promised resolution, infrequent enough that the due-scan stays cheap. Tick frequency
  is a config, not code (§B.2 posture).
- **`FOR UPDATE SKIP LOCKED` batch cap.** The due-scan claims a **bounded batch** of due `outreach_log` rows
  with `SELECT … FOR UPDATE SKIP LOCKED LIMIT {cap}` — so even if (against the leader lock) two scanners run,
  they claim **disjoint** rows and never advance the same enrollment twice; and a single tick can never
  enqueue an unbounded fan-out that starves the send queue (§A.8). The claimed rows advance `current_step` /
  `last_event_at` on `outreach_log` in the same transaction.
- **Idempotency backstop.** Every enqueued step still carries an Idempotency-Key into the send path (D5,
  `idempotency_keys`), so even a pathological double-claim cannot produce a second send.

**Mandatory itest (P4 "Done when").** A **two-worker no-double-advance itest**: run two `email_sequence_tick`
instances against the same seeded enrollments and assert each due step advances **exactly once** and produces
**exactly one** send — the structural proof behind known-gap #5 (`13 §6`). This itest extends the cross-tenant
isolation itest family (`13 §7`) and runs in CI (Docker/Postgres/Redis).

**Contract.** The scheduler is leader-locked, claims bounded batches via `FOR UPDATE SKIP LOCKED`, advances
`outreach_log` transactionally, and is proven single-fire by the two-worker itest before `email.sequences` is
enabled for any tenant (`13 §3`).

### A.5 Webhook ingestion backpressure — bounded queue, fast 2xx, 503 when full

**What it is.** Every externally sourced event (ESP delivery/bounce/complaint webhooks; Gmail/Graph push)
enters through the thin edge endpoint in `apps/api/src/features/outreach/routes.ts` (the email-feature
routes), which verifies the signature, validates the payload, **enqueues to the tracking queue, and returns
`2xx` fast** (`04 §6.1`). The risk at volume is an ESP event storm (a bulk send's deliveries land in a
narrow window, plus retries) overrunning the ingestion queue.

**The design.**
- **Bounded ingestion queue.** The tracking queue has a **bounded depth**; the edge checks depth (or an
  enqueue admission gate) before accepting.
- **Return `503` to the ESP when full.** When the queue is at capacity the edge returns **`503` with
  `Retry-After`** — and **ESPs retry on `5xx`** (`04 §6.3`), so a transient overrun is absorbed by the
  provider's own retry/backoff, never by us silently dropping events. This is the correct backpressure
  signal: a slow database or a full queue makes the ESP **wait and retry**, it does not make us lose mail or
  fall over.
- **Fast `2xx` otherwise.** When there is capacity, the edge enqueues and returns `2xx` within the ESP's
  retry deadline (~10s, `04 §6.1`) — the worker (with tenant context per job, D10) does all matching,
  classification, suppression writes, and the `email_event` → `activities` projection asynchronously.
- **Idempotent ingest** (D5-style, on the provider event id) means an ESP retry after a `503` is a no-op if
  the event was in fact already accepted (`04 §6.3`).

**Contract.** The edge is write-light and bounded: fast `2xx` when there is capacity, `503`+`Retry-After`
when full, never a synchronous DB write on the public hot path, never a dropped event.

### A.6 Per-tenant send-quota — the `creditRepository` lock pattern, low-frequency and money-correct

**What it is.** The genuinely-new per-tenant **send-quota** (the metered-spend / abuse cap, known-gap #3 in
`13 §6`) is the **one** counter that *should* use the `creditRepository` `SELECT … FOR UPDATE` pattern
(`packages/core/src/billing/creditRepository`, the documented template, D11): `lockBalance` → decrement under
lock with a `CHECK` no-overdraft → idempotent grant. It is money-correct and must never over-spend.

**Why this is *not* a hot-row problem here.** The quota is decremented **once per send authorization**, not
per throttle tick, and the throttle (§A.1, Redis) absorbs the high-frequency rate decisions *in front of* it
— so the quota lock is taken at the (much lower) authorized-send frequency, not the raw attempt frequency.
The §A.1/§A.6 split is the whole point: **Redis for the per-second rate, the FOR-UPDATE counter for the
money.** Wiring this quota *into* the metered send path is a precondition of enabling `email.send` (`13 §3`,
known-gap #3).

**Contract.** The send-quota reuses the `creditRepository` lock pattern (D11), is decremented per authorized
send under lock with no-overdraft, is idempotent, and is wired into the send path before any tenant sends.
The per-mailbox throttle (§A.1) is **not** this counter.

### A.7 Suppression-check caching — Redis, short TTL, invalidate on write

**What it is.** `assertNotSuppressed` (`packages/core/src/compliance/assertNotSuppressed.ts`) is the
unbypassable D4 gate — it runs **in-tx in `sendStep`** on every send and again in the reveal path. At send
volume, hitting `suppression_list` (by `email_blind_index` / `domain` / `phone_blind_index` / `contact_id`)
on **every** send is a read-amplification problem.

**The design.**
- **Short-TTL Redis cache** of suppression decisions keyed by `{tenant_id}:{workspace_id}:{match_key}`, with
  a deliberately **short TTL** so a stale "not suppressed" cannot persist long.
- **Invalidate on write.** Any suppression write — manual add (`/settings/compliance`), hard-bounce
  (`handleBounce.ts` inserts a workspace suppression row), unsubscribe, complaint — **invalidates** the
  relevant cache key synchronously, so a fresh suppression is honored immediately.
- **Cache is an optimization, not the gate.** The fail-closed, in-tx `assertNotSuppressed` (D4) remains the
  authority. The cache only avoids the read when it can prove a recent decision; on any cache miss or doubt,
  the in-tx DB check runs. **A cache must never turn a "suppressed" into a "send".** D4 wins over performance
  (security precedence, CLAUDE.md).

**Contract.** Suppression caching is Redis, short-TTL, invalidate-on-write, and strictly an accelerator in
front of the unchanged fail-closed in-tx D4 gate — never a replacement for it.

### A.8 `idempotency_keys` expiry sweep, and queue isolation so email never starves others

**`idempotency_keys` expiry sweep.** `idempotency_keys` (`packages/db/src/schema/billing.ts`,
`UNIQUE(tenant_id, key)`, D5) backs send idempotency. Without an expiry sweep this table grows monotonically.
A **scheduled sweep** (a low-priority repeatable job, leader-locked like §A.4) deletes keys past their
retention window. Keys are short-lived by purpose (they only need to outlive the at-least-once retry window),
so the sweep keeps the unique-constraint index small and write-fast. The sweep is itself idempotent and
batched (bounded `DELETE … LIMIT`) so it never long-locks the table.

**Queue isolation — email must not starve the rest of TruePoint.** Email is bursty (a sequence fan-out, an
ESP event storm) and shares the BullMQ/Redis substrate with enrichment, imports, scoring, firmographics, and
DSAR (`apps/workers/src/queues/*`). The contract:
- **Named, separate queues** per D10 (`email_send` / the tracking ingestion queue / `email_warmup` /
  `email_sequence_tick`) — never a shared "misc" queue.
- **Bounded concurrency and fairness per queue** so an email burst consumes its own worker budget and cannot
  monopolize the workers that serve enrichment/imports/DSAR. The §A.4 batch cap and §A.5 backpressure keep
  the email queues' depth bounded; per-queue concurrency caps keep their *worker* share bounded.
- **Per-tenant fairness within the email queues** (D10) so one tenant's million-recipient sequence does not
  starve another tenant's 50-recipient sequence.

**Contract.** Email queues are isolated, individually concurrency-capped, and per-tenant-fair; an email
storm degrades email latency (gracefully, via backpressure) but **never** starves enrichment, imports,
scoring, or DSAR.

### A.9 Per-phase scale gates and the P5 load-test SLO

These gates extend the per-phase "Done when" in `13 §5` — a phase does not ship its scale-relevant work unit
until its gate is met.

| Phase (`13`) | Scale gate (in addition to the phase's functional "Done when") |
|---|---|
| **P1** (send path) | Per-mailbox throttle is **Redis + queue-local** (§A.1), proven to *not* place a hot counter on a DB row; the send-quota uses the `creditRepository` FOR-UPDATE pattern (§A.6) and is wired before `email.send` (known-gap #3). |
| **P3** (tracking) | `email_event` is **range-partitioned by day** (§A.2); ingestion holds the **< 1M events/day** SLO with the edge returning fast `2xx` and **`503`+`Retry-After` under load** (§A.5); suppression-check caching is in place (§A.7). |
| **P4** (sequences) | `email_sequence_tick` is **leader-locked** with a **`FOR UPDATE SKIP LOCKED` batch cap** and passes the **two-worker no-double-advance itest** (§A.4); email queues are concurrency-capped and per-tenant-fair (§A.8). |
| **P5** (analytics + volume) | Analytics read **partitioned hour/day rollups**, never the firehose (§A.3); retention is automated partition `DROP` (§A.2); the **P5 load-test SLO** below passes. |

**The P5 load-test SLO (the headline scale gate).** Before email is enabled at volume for production tenants,
a load test must sustain **10M `email_event` rows/day** ingested with:
- **no hot-row contention** — confirmed by the absence of single-row lock waits on the throttle (§A.1), the
  scheduler (§A.4), or the suppression path (§A.7); the only FOR-UPDATE lock under load is the
  low-frequency send-quota (§A.6);
- **no ingestion backlog** — the tracking queue drains within the doc `14` ingestion-latency SLO, shedding to
  `503`+`Retry-After` (§A.5) under spikes rather than backing up unboundedly;
- **partition health** — day partitions are pre-created ahead of ingestion and retention drops keep total
  `email_event` size bounded; rollup lag stays within the dashboard freshness SLO (§A.3);
- **no cross-subsystem starvation** — enrichment/imports/DSAR queue latency is unaffected by the email storm
  (§A.8).

**Contract.** The P5 load-test SLO is a hard gate: 10M events/day with **no hot-row contention and no
backlog**. It is owned operationally by doc `14` (SLO/observability/runbook); this doc owns the *design
properties* that make it achievable.

---

## Part B — Extensibility

Part B catalogs the seams the design deliberately leaves open. For each: **what exists today** (in M9/M12),
**what to add** to extend it, and **when** (the triggering phase or condition). The discipline throughout:
extend at a **seam that already exists** (the `channel` enum, the `EmailSenderPort`, the `webhooks` table,
the `provider-configs` admin) — never by forking a parallel subsystem (the D11 anti-pattern).

### B.1 Multi-channel — widen handler routing off the existing `channel` enum

- **What exists.** `outreach_steps.channel` (`packages/db/src/schema/outreach.ts`) is already an enum with
  **`email | linkedin`**, and `activities.channel` already spans `email | phone | linkedin | sales_navigator
  | in-person`. The cadence model is **already channel-aware** — the M9 engine simply only *handles* email
  today (`00 §2`, out-of-scope: non-email channels).
- **What to add.** **Handler routing** in the cadence engine and the worker: dispatch a due step to the
  channel-appropriate handler based on `outreach_steps.channel`, with `email` routing to `sendStep` /
  `EmailSenderPort` and `linkedin` (and later `sms`, `call`) routing to their own send handlers. The
  schema does not change to add `linkedin`; only the routing/handler layer widens. Adding `sms`/`call` is a
  **single enum value + one handler**, not a new sequence/enrollment model — `outreach_sequences` /
  `outreach_steps` / `outreach_log` carry every channel.
- **When.** `linkedin` routing is the **first** multi-channel extension (the enum value already exists);
  `sms`/`call` are **later** (post-P6, roadmap — `00 §2` out-of-scope today). Each new channel inherits the
  D4 suppression gate (`suppression_list` already has `match_type` `phone`), D5 idempotency, and D8 ownership
  unchanged.

### B.2 Pluggable `ProviderAdapter` — config-not-code, registered via the `/provider-configs` admin

- **What exists.** The send seam is **`EmailSenderPort`** (`packages/core/src/outreach/senderPort.ts`:
  `{ send(OutboundEmail) -> { messageId } }`) with a `consoleSender` today; the M12 SES/mailbox adapter
  **swaps the port without touching the `sendStep` transaction** (D11). The internal admin already ships a
  **Providers `/provider-configs`** surface (`apps/admin/src` — ESP/SMS/enrichment provider config), fully
  built, on the same `fetchWithAuth` + `StateSwitch` + `DataTable` pattern.
- **What to add.** A formalized **`ProviderAdapter` interface**:
  `send(mailbox, recipient, subject, body, headers) -> { providerMessageId, error }` — the generalization of
  `EmailSenderPort` that a new ESP/relay (SES, Postmark, SendGrid, Mailgun per D1) or a mailbox provider
  implements. Adapters are **registered as configuration via `/provider-configs`** (which provider is active
  for a tenant/pool, with credentials stored server-side per D7), **not** by editing code and redeploying.
  The `sendStep` transaction calls the resolved adapter through the port — the D4 gate, D5 idempotency, the
  CAN-SPAM footer append, and the `outreach_log` advance are all unchanged regardless of adapter.
- **When.** The **interface + first real adapter (SES, D1 default)** land in **P1** (the send path).
  Additional adapters (Postmark for system mail, SendGrid/Mailgun alternates) are **added as config** at any
  later point with **no code change to the send tx** — that is the whole purpose of the seam.

### B.3 External event bus — reuse the `webhooks` table, emit signed `email.*` events

- **What exists.** TruePoint already has a **`webhooks`** table (`packages/db/src/schema/webhooks.ts`) for
  external subscriber registrations — explicitly earmarked for an email event bus (D11, `00 §5`).
- **What to add.** Emit **signed outbound `email.*` events** to registered subscribers as the corresponding
  facts are committed: `email.sent` / `email.delivered` / `email.bounced` / `email.replied` /
  `email.unsubscribed`. Each is published **post-commit** off the same point that writes `activities` /
  `outreach_log` (so the bus never diverges from the durable record), is **signed** (the same signing
  discipline the inbound side verifies, `04 §6.2`), carries **IDs and event type only — never PII or message
  bodies** (audit posture, `00 §5`), and is **tenant-scoped** (a subscriber only receives its own tenant's
  events). Delivery is queued, retried, and per-tenant-fair like every other queue (§A.8).
- **When.** Hooks into the same projection worker that ships in **P3** (tracking) for the engagement events
  and **P1** for `email.sent`/`email.delivered`/`email.bounced`; the subscriber-facing emission can be flagged
  on (`email.*` flag family, `13 §3`) once the `webhooks` registration UI/scoping is governed (P6 admin).

### B.4 A/B on step variants — a `weight` field today, MVT/bandit later

- **What exists.** Nothing variant-level yet — `outreach_steps` carries a single `subject`/`body` per
  `(sequence_id, step_order)`.
- **What to add.** A **`weight` field on step variants**: allow more than one variant for a step and a
  weight that controls the split, so the send path picks a variant per enrollment by weight. This is an
  **additive** extension to the step model (variants reference the parent step; ownership/D8 and the send tx
  are unchanged). It feeds the reply-rate-primary analytics (D6, `08`) per variant.
- **When.** The `weight` field is the **near-term** A/B primitive (post-P5, once analytics can score
  variants by reply rate). **MVT (multivariate) and bandit allocation** — dynamically shifting weight toward
  the higher-reply-rate variant — are **later**, built **on top of** the same weight field by letting the
  allocator update weights from the rollup feedback (§A.3), not by introducing a new model.

### B.5 AI personalization — model A/B + a reply-rate feedback loop

- **What exists.** The web surface already ships an **AI `DraftReviewPanel` stub** and a **Templates panel
  stub** (`features/sequences`, `fetchTemplates -> MaybeList available:false`); AI authoring is explicitly
  **roadmap, not P0** (`00 §2`).
- **What to add.** **Model A/B** for AI-personalized variants (route a fraction of generations through model
  A vs model B), tied into the **reply-rate feedback loop**: the rollups (§A.3, D6 reply-rate-primary) score
  which model/prompt produces higher *reply* rate (not opens), and that signal feeds back into model/prompt
  selection. This reuses the B.4 variant/`weight` mechanism for the A/B split and the §A.3 rollups for the
  feedback — no new analytics path. Generated drafts always pass through human review (the `DraftReviewPanel`
  seam) and the unchanged D4/D5/D9 send guarantees.
- **When.** **Later** (post-P6 roadmap) — gated behind its own `email.*` flag, built on the B.4 weight field
  and the §A.3 reply-rate rollups already in place by P5.

### B.6 Analytics warehouse export — batch to S3 / BigQuery, PII-free send rows

- **What exists.** The P5 rollups (§A.3) and the partitioned `email_event` store (§A.2) hold the analytics
  data in Postgres; the `/reports` "Sending & deliverability" tab is a placeholder today (ground truth).
- **What to add.** A **batch export** of **PII-free** send/event rows (IDs, event types, timestamps,
  tenant/workspace scope, bounce class, normalized UA family — **never** recipient PII or message bodies, per
  `04 §2.2` and the audit posture) to an external warehouse (**S3** as a landing zone, **BigQuery** for
  query). The export reads from the **cold `email_event` partitions before they are dropped** (§A.2) and from
  the daily rollups (§A.3), so retention-drop and warehouse-export are coordinated (export precedes drop). The
  export is per-tenant-scoped and respects residency/retention (`06`, known-gap #4 in `13 §6`).
- **When.** **P5 or later** — once partitioning + rollups exist; it is an additive consumer of data that
  already exists, not a new write path.

### B.7 Explicitly out of scope — BYO-IP / BYO-SMTP reputation isolation and warmup

**BYO-IP and BYO-SMTP are explicitly OUT OF SCOPE** for this plan set, including any **per-customer dedicated
IP reputation isolation or IP warmup**. The reputation model is **per-tenant authenticated sending domain +
mailbox pool** (D2), with a dedicated outbound IP supported only as an **optional** part of a Reputation Pool
and **not** a P0–P6 deliverable (`00 §2` out-of-scope). This doc does **not** plan BYO-IP/BYO-SMTP reputation
isolation or warmup; the `ProviderAdapter` seam (§B.2) can later accommodate a customer's own SMTP relay as a
**transport** adapter, but the **reputation-isolation and warmup** semantics of a customer-owned IP are
deliberately not designed here and would be a separate, future decision (a new ADR), not an extension of this
plan.

---

## Cross-references

- **`13-rollout-phases.md`** — owns the **Phase Map (P0–P6)** and the per-phase "Done when". Every scale gate
  in §A.9 extends a phase's "Done when"; the two-worker no-double-advance itest (§A.4) is a P4 gate addressing
  known-gap #5; the send-quota wiring (§A.6) is the known-gap #3 mandate; the `email.*` flag discipline gates
  every extensibility seam in Part B.
- **`14`** — owns the **operational SLO / observability / runbook** detail this doc's SLOs (§A.2, §A.5, §A.9)
  are measured against; the P5 load-test SLO is run and monitored per doc `14`.
- **`04-status-event-tracking.md`** — owns the event vocabulary and the signed, idempotent, fast-`2xx`
  ingestion edge this doc backpressures (§A.5) and the `email_event` → `activities` projection (§A.2).
- **`08-reporting-analytics.md`** — consumes the partitioned rollups (§A.3); reply rate is the headline (D6).
- **`07-multitenancy-reputation-isolation.md`** — owns D2/D3 reputation isolation that §B.7 declines to extend
  to BYO-IP.
- **`12-roles-permissions.md`** — owns D8 owner-scope that the rollups (§A.3), the event bus (§B.3), and the
  warehouse export (§B.6) all respect.
- **`00-overview.md`** — D1–D11, the shared vocabulary, and the eight-platform landscape this doc builds on.

> **Closing — this is the scale-and-growth contract.** Part A's rule is **Redis + queue-local for the
> high-frequency rate, partitions for the firehose, the `creditRepository` FOR-UPDATE lock only for the
> money** — proven by the P5 10M-events/day load-test SLO with no hot-row contention and no backlog. Part B's
> rule is **extend the seam that already exists** — the `channel` enum, the `EmailSenderPort`/`ProviderAdapter`,
> the `webhooks` bus, the step-variant `weight`, the `/provider-configs` admin — never fork a parallel
> subsystem (D11). BYO-IP/BYO-SMTP reputation isolation is the one thing deliberately left out (§B.7).
