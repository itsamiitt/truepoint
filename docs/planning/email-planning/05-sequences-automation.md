# Email — Sequences & Automation (05)

> Cites the **Shared Vocabulary**, the **Locked Decisions (D1–D10)**, the **Phase Map (P0–P6)** and the
> **Canonical Entities** fixed in `00-overview.md` — verbatim, not re-litigated. This doc owns the
> **sequence engine**: how a multi-touch cadence is modelled, ticked, branched, scheduled, auto-paused, and
> enrolled into without overwhelming a mailbox. It is the customer-facing automation layer; the entities it
> describes (`email_sequence`, `email_sequence_step`, `email_enrollment`) are **owned by `09-data-model.md`**
> and this doc proposes their behaviour, not their final DDL. Sibling docs it leans on:
> `02-sending-infrastructure.md` (per-mailbox limits, throttle, warmup), `04-status-event-tracking.md` (the
> reply / bounce / OOO events auto-pause consumes), `06-compliance.md` (unsubscribe honoured mid-sequence,
> D9), `08-reporting-analytics.md` (sequence metrics), `10-web-surface.md` (the Sequences tab),
> `12-roles-permissions.md` (who may build/enroll). **Sequences ship in Phase 4 (`13 §P4`).**
>
> **Scope:** the engine + its queue + its lifecycle. Templating (`01`), the raw send path (`02`), tracking
> ingestion (`04`), and the surface (`10`) are owned elsewhere; this doc consumes them.

---

## 1. What a sequence is in TruePoint

A **Sequence** (industry term: *cadence*) is a tenant-authored, repeatable series of touchpoints aimed at a
prospect, run automatically over days/weeks until the prospect replies, bounces, unsubscribes, or the steps
run out. This is the model every best-in-class engagement platform shares: a Salesloft cadence is "a
repeatable series of touchpoints" built from **steps** (the touch), **timing** (the delay, in days), and
**channels** (email / call / LinkedIn) — see [Salesloft — Multi-Touch Cadence Workflows](https://help.salesloft.com/s/article/Multi-Touch-Cadence-Workflows?language=en_US).
Apollo, Reply.io and Lemlist use the identical step/delay/channel decomposition under the name *sequence*
([Apollo — Sequences Overview](https://knowledge.apollo.io/hc/en-us/articles/4409237165837-Sequences-Overview)).

TruePoint adopts this model with three canonical entities (owned by `09`, RLS-FORCED, `tenant_id` always,
`workspace_id` workspace-scoped, `owner_user_id` user-owned per D8):

| Entity | Role | Key columns (proposed; `09` finalizes) |
|---|---|---|
| `email_sequence` | The template/definition: name, status (`draft`/`active`/`archived`), default send-window + timezone policy, per-mailbox throttle hints. | `tenant_id`, `workspace_id`, `owner_user_id`, `name`, `status`, `send_window`, `timezone_mode`, `daily_cap`, `created_at`, `deleted_at` |
| `email_sequence_step` | One ordered touch in the sequence: type, the `email_template` it renders, delay-from-previous, branch rules, A/B variants. | `sequence_id`, `step_order`, `step_type`, `template_id` (FK `email_template`), `delay_*`, `branch_*`, `variant_group` |
| `email_enrollment` | One prospect's run **through** a sequence: current step, state, next-tick-at, the mailbox it sends from. | `tenant_id`, `workspace_id`, `owner_user_id`, `sequence_id`, `contact_id`, `mailbox_integration_id`, `current_step_order`, `state`, `next_action_at`, `paused_reason`, `enrolled_at`, `finished_at` |

A **send** produced by a step is still an `email_send` row (the same idempotent, suppression-gated, tracked
send `02`/`04` define) — the sequence engine does **not** invent a second send path. It composes the existing
one. This matters for D4 (suppression gate fires on *every* send), D5 (every send idempotent), and D10 (the
send still fans out through the `email_send` queue).

---

## 2. Multi-touch cadences (steps, delays, channels)

### 2.1 Best-in-class

- **Steps + day-delays.** Every cadence/sequence is an ordered list of steps, each with a delay measured in
  **days** from the prior step. Multiple touches *on the same day* (a "multi-touch" day — e.g. a call then an
  email) are explicitly supported by Salesloft by marking the step **multi-touch**, which makes it due
  immediately after the previous step rather than after a day-delay
  ([Salesloft — Multi-Touch Cadence Workflows](https://help.salesloft.com/s/article/Multi-Touch-Cadence-Workflows?language=en_US)).
- **Mixed channels.** Steps are not all email. A proven distribution is ~50–60% email, 25–30% phone,
  15–20% LinkedIn, with >80% of top reps running a triple-touch email+phone+LinkedIn approach
  ([Octave — Build High-Converting Salesloft Cadences](https://www.octavehq.com/post/how-to-build-high-converting-salesloft-cadences)).
  Non-email steps are **manual tasks**: the platform creates a to-do for the rep ("call X", "connect on
  LinkedIn") rather than performing the action itself.
- **Timing shape.** Best-performing cadences front-load: many touches in the first ~10 business days, widening
  the gap between touches over time, then nurture once or twice a month
  ([Octave](https://www.octavehq.com/post/how-to-build-high-converting-salesloft-cadences)).
- **Message shape.** "Personalize → automate → personalize": a hand-personalized opener, automated middles, a
  personalized re-engagement at the end ([Octave](https://www.octavehq.com/post/how-to-build-high-converting-salesloft-cadences)).

### 2.2 Recommended for TruePoint

Model a sequence as an **ordered list of `email_sequence_step` rows** (`step_order` ascending). Each step
carries a `step_type` and a **delay from the previous step**, expressed as `delay_days` + optional
`delay_hours` for same-day/multi-touch; `delay_days = 0` is the "due immediately after previous" multi-touch
case. The **step-type table** (the contract for what an engine tick does at each step):

| `step_type` | What the engine does on tick | Produces | Notes |
|---|---|---|---|
| `email_auto` | Renders the step's `email_template` for the contact's mailbox, runs the **D4 suppression gate**, then enqueues an idempotent `email_send` (D5) via the `email_send` queue (D10). | `email_send` row | The only step type that sends automatically. Subject to send-window, timezone, daily-cap, jitter (§4). |
| `email_manual` | Drafts the email and creates a **task** for `owner_user_id` to review + send (the "personalize" touch). No auto-send. | task | Engine waits on task completion before advancing. |
| `call_task` | Creates a manual **call task** for the owner; engine pauses the enrollment's auto-advance until the task is marked done/skipped. | task | TruePoint dialer integration is out-of-scope here; this is a to-do. |
| `linkedin_task` | Creates a manual **LinkedIn task** (connect / message). | task | Manual; no LinkedIn automation (compliance + ToS). |
| `wait` | Pure delay node — no touch. Used to widen the gap between touches without a separate action. | — | Lets the timing-shape (front-load then widen) be modelled explicitly. |

**Channel scope at launch.** Phase 4 ships the engine with **email steps fully automated** (`email_auto`,
`email_manual`) and **non-email steps as tasks** (`call_task`, `linkedin_task`, `wait`). This matches the
"email scales, phone/LinkedIn are human moments" reality and keeps the automated blast radius to the one
channel TruePoint owns end-to-end (the mailbox). It also means non-email steps never touch the send path,
the suppression gate, or deliverability — they are pure task rows.

### 2.3 Tradeoffs

| Choice | Pro | Con / mitigation |
|---|---|---|
| Day-delay between steps (not absolute dates) | Sequence definition is reusable across enrollments enrolled on different days. | "Send on March 3" campaigns need a `wait` + send-window; acceptable, those are rare in outbound. |
| Non-email steps as manual tasks | No ToS/automation risk on LinkedIn; reps keep human judgement on calls. | Sequence can stall on an un-actioned task — surface overdue tasks in `10`; allow auto-skip-after-N-days as a per-step option. |
| One `email_send` path reused | D4/D5/D10 guarantees inherited for free; one place to audit. | Engine must compose, not bypass, the send queue — slightly more orchestration (§7). |

---

## 3. Conditional branching & A/B variants

### 3.1 Best-in-class

- **Behavioural branching.** "If-then paths based on prospect behaviour" — if someone opens but does not
  reply, send a different follow-up; if they click the pricing link, move them to another path. "Branching is
  where automation becomes personalization" ([MailAdept — Email Automation Guide 2026](https://www.mailadept.com/email-automation)).
- **A/B step variants.** Outreach, HubSpot and Apollo all support A/B testing a *step*: two template variants
  on the same step, sends split evenly, with per-variant stats on sends/opens/clicks/replies/meetings; the
  winner is promoted to the permanent template
  ([Outreach — A/B Testing Sequence Steps](https://support.outreach.io/hc/en-us/articles/205083718-A-B-Testing-Sequence-Steps-in-Outreach),
  [Apollo — Use an A/B Test in a Sequence](https://knowledge.apollo.io/hc/en-us/articles/4410749683597-Use-an-A-B-Test-in-a-Sequence)).

### 3.2 Recommended for TruePoint

**Branching (Phase 4 — keep it modest at launch).** Most outbound value comes from the *negative* branch
(stop or change touch on reply/bounce) which §5 already covers via auto-pause, not from elaborate positive
trees. So Phase 4 ships **linear sequences with auto-terminal events** (reply/bounce/unsub end the run) plus
a **single optional condition per step**: "if `opened`/`clicked` since the previous step → use variant B (or
skip to step N); else continue." Branch facts come **only** from `email_tracking_event` rows already ingested
by `04`. The engine never trusts a client-asserted "opened" — it re-reads the event store at tick time.

> **D6 guardrail.** Opens are **informational, not a KPI** (D6). A branch *may* read `opened` to pick a
> warmer follow-up, but the engine must **not** make `opened` a *gating* signal for whether to send at all
> (a missed open-pixel must never silently halt a real follow-up). `clicked` and `replied` are reliable;
> `opened` is best-effort. Document this on each branch in the builder (`10`).

**A/B variants.** Model variants as multiple `email_sequence_step` rows sharing a `variant_group` id with a
split weight, or a `variants[]` array on one step (`09` picks the shape). At enrollment-creation the engine
**deterministically assigns** a variant from the enrollment id (stable hash → no flip-flop on retry, D5-safe)
and records the chosen `template_version_id` on the resulting `email_send` so `08` can attribute
sends/clicks/replies per variant. Splits default 50/50; a tenant may promote a winner (point both weights at
the winning variant) without restructuring the sequence.

### 3.3 Tradeoffs

| Choice | Pro | Con / mitigation |
|---|---|---|
| Single condition/step at launch, not a full graph | Tiny state machine; `current_step_order` stays a number, not a node id. | No "click pricing → jump to demo-booking sub-sequence". Defer rich branching to a later phase; the data model leaves room. |
| Branch reads only `04` events | One source of truth; no engine-local engagement cache to drift. | A late-arriving tracking event can arrive after the tick; accept eventual consistency — the branch reflects state *at tick time*, which is correct semantics. |
| Deterministic variant assignment by enrollment id | Idempotent (D5): a re-tick re-derives the same variant; even split over a large cohort. | Tiny cohorts skew; surface this caveat in `08` (don't trust an A/B with n<~200, mirroring Outreach guidance). |

---

## 4. Send-window, timezone scheduling, daily caps & jitter

### 4.1 Best-in-class

- **Business hours in the recipient's timezone.** Send during business hours only (≈9 AM–5 PM **recipient
  timezone**, not the sender's), commonly Tue–Thu 9–11 AM local; reduce weekend volume to ~50–70%
  ([Prospeo — Cold Email Time Zones 2026 Guide](https://prospeo.io/s/cold-email-time-zone),
  [Zeliq — Best Days and Times to Send B2B Cold Emails](https://www.zeliq.com/blog/best-days-for-email-open-rates)).
- **Daily caps per mailbox.** The 2024–2025 consensus is roughly **20–50 cold emails per mailbox per day**,
  with deliverability dropping above ~30–40/day for newer Gmail mailboxes, and the cap *includes* warmup
  volume ([Smartlead — Email Sending Frequency](https://www.smartlead.ai/blog/email-frequency-best-practices-for-cold-emails),
  [Topo — Safe Sending Limits 2025](https://www.topo.io/blog/safe-sending-limits-cold-email)).
- **Jitter / look-human.** Spread sends across the window (sends ~2–3 min apart), and **randomize** the exact
  time within the window and the daily count so no two go at the same instant — explicitly to dodge
  pattern-based spam filters ([Smartlead — Cold Email Checklist](https://www.smartlead.ai/blog/cold-email-checklist),
  [Prospeo — Cold Email Time Zones](https://prospeo.io/s/cold-email-time-zone)).

### 4.2 Recommended for TruePoint

A `email_auto` step does **not** send the instant its delay elapses. When its delay elapses the engine
computes the **earliest valid send instant** and parks `email_enrollment.next_action_at` there:

1. **Send-window + timezone.** Resolve the recipient's timezone (from the contact's data; fall back to a
   tenant default, then mailbox default). Snap `next_action_at` into the sequence's configured `send_window`
   (e.g. 09:00–17:00) **in recipient-local time**, on an allowed weekday (`timezone_mode` of
   `recipient` | `mailbox` | `tenant_fixed`; default `recipient`). If the elapsed instant is outside the
   window, roll forward to the next window open.
2. **Daily cap (per mailbox).** Before committing, check the **per-mailbox daily counter owned by `02`** — the
   same counter that bounds warmup + manual + sequence sends together (caps include warmup, per the sources).
   If the mailbox is at cap for the recipient-local day, push `next_action_at` to the next day's window. The
   cap is **not** re-implemented here; the engine *consumes* `02`'s mailbox-limit service.
3. **Jitter.** Add a bounded random offset (e.g. ±a few minutes, configurable) to `next_action_at` and rely on
   `02`'s natural send spacing so a cohort of enrollments does not fire in a synchronized burst. Jitter is
   applied at scheduling time and persisted, so a retry (D5) re-uses the same instant rather than re-rolling.

The actual send still goes through the `email_send` queue (D10) with the D4 suppression gate and D5
idempotency — §4 only decides *when* the enrollment becomes eligible.

### 4.3 Tradeoffs

| Choice | Pro | Con / mitigation |
|---|---|---|
| Recipient-local windows by default | Matches the strongest 2024–2026 deliverability guidance; opens/replies cluster in-window. | Needs a timezone per contact; many records lack it → documented fallback chain (contact → tenant default → mailbox). |
| Daily cap delegated to `02` | One counter, one source of truth; warmup+manual+sequence share it (caps *include* warmup). | Engine must call `02` synchronously at schedule time; cache the per-mailbox remaining count per tick batch to avoid hot-row contention. |
| Persisted jitter (not re-rolled on retry) | Idempotent; a redelivered tick lands on the same instant. | Slightly less "random" across retries; acceptable — the goal is de-synchronizing the *cohort*, which persisted-per-enrollment offsets already achieve. |

---

## 5. Auto-pause on reply / OOO / bounce (consumes `04` events)

### 5.1 Best-in-class

A cadence **must stop automatically** when the prospect replies, books a meeting, converts, or opts out, and
**pause** on out-of-office or a bounce; "auto-pause triggers every cadence must have" are reply, OOO, hard
bounce, soft-bounce spike, holiday window, meeting booked
([ConnectSafely — When to Pause an Outreach Cadence](https://connectsafely.ai/articles/pause-cadences-cold-outreach-rules-2026)).
Apollo pauses a contact on a reply and on an OOO auto-reply — and can *auto-resume* after the OOO return date
([Apollo — Sequences Overview](https://knowledge.apollo.io/hc/en-us/articles/4409237165837-Sequences-Overview)).
A bounce sets the contact's sequence status to `bounced`. The 2026 stakes are high: Google/Microsoft score
sender reputation over multi-week rolling windows, so a cadence firing into a high-bounce day can sink a
domain for weeks ([ConnectSafely](https://connectsafely.ai/articles/pause-cadences-cold-outreach-rules-2026),
[Outreach — Bounce and auto-reply detection](https://go-outreach.com/features/bounce-and-auto-reply-detection)).
Bounce-spike thresholds: pause a *sender's* cadences when bounce rate exceeds ~3% over 200 sends or ~5% over
100 ([ConnectSafely](https://connectsafely.ai/articles/pause-cadences-cold-outreach-rules-2026)).

### 5.2 Recommended for TruePoint

Auto-pause is **event-driven**, not polled. The `email_tracking` ingestion (`04`, D10) already classifies and
records `email_tracking_event` rows for reply, bounce (hard/soft), unsubscribe, and OOO. When `04` ingests one
of these for a contact that has a **live `email_enrollment`**, it transitions the enrollment (this is the one
place the engine reacts to inbound, not the tick):

| Inbound event (from `04`) | Enrollment transition | Resume behaviour |
|---|---|---|
| `replied` (genuine reply) | `active → replied` (terminal) | None — a human takes over. |
| `bounced` (hard) | `active → bounced` (terminal) | None; contact also gets an `email_suppression` row (D4/`06`) so it can't be re-sent. |
| `bounced` (soft) | stay `active`, increment a soft-bounce counter | After N soft bounces or a sender-level spike threshold, escalate to `paused` (reason `soft_bounce_spike`). |
| `unsubscribed` (or List-Unsubscribe / opt-out) | `active → unsubscribed` (terminal) | None — **D9: unsubscribe is honoured mid-sequence**; an `email_suppression` + `email_consent` revocation is written so no future step or sequence can send. |
| `out_of_office` (OOO auto-reply) | `active → paused` (reason `ooo`), set `resume_at` if a return date is parsed | Auto-resume at `resume_at` if parsed; else stay paused for a default 7–14 day window and re-verify before resuming (per Apollo/ConnectSafely norms). |

Because every step send re-runs the **D4 suppression gate (fail-closed, re-checked before each step)**, even
if an auto-pause event is briefly delayed, a step send for a now-suppressed/unsubscribed contact is still
blocked at send time — auto-pause and the per-step gate are **belt-and-suspenders**. D9 specifically requires
unsubscribe to halt an in-flight sequence, which both the enrollment transition *and* the per-step gate
enforce.

A **sender/mailbox-level circuit breaker** (owned jointly with `02`/`03`): when a mailbox's recent bounce rate
crosses the threshold, pause **all** that mailbox's active sequence steps (not just one enrollment) and alert
the owner + admin (`11`). This protects the shared reputation pool (D2 isolation is per-tenant; a runaway
sequence must not torch the tenant's own pool).

### 5.3 Tradeoffs

| Choice | Pro | Con / mitigation |
|---|---|---|
| Event-driven pause via `04` | Near-real-time; no polling load; one classifier. | Depends on `04` reply/OOO classification quality — a mis-classified OOO-as-reply ends a sequence early. Mitigate with the per-step gate + an owner "resume" affordance. |
| OOO auto-resume on parsed return date | Matches Apollo; no rep babysitting. | Date-parsing is best-effort; default to a fixed pause window + manual resume when no date is parsed. |
| Mailbox-level circuit breaker | Protects the tenant's reputation pool (D2). | A noisy breaker pauses good sequences; make the threshold tenant-tunable and require admin alert + audit. |

---

## 6. Throttled enrollment (ramp, backpressure, per-mailbox limits)

### 6.1 Best-in-class

Enrolling thousands at once is dangerous — "large enrollment spikes trigger spam filters and overwhelm your
ability to handle replies", so start with 50–100 contacts, validate, then scale gradually
([AI-Productivity — Apollo Sequences 2026](https://aiproductivity.ai/guides/apollo-sequences-automated-outreach/)).
Apollo throttles via a **max emails per rolling 24-hour period** per sequence, and recommends starting at
20–30/day and ramping over 2–3 weeks ([Apollo — Configure Email Sending Limits](https://knowledge.apollo.io/hc/en-us/articles/4409233349005-Configure-Email-Sending-Limits)).
Smartlead/Instantly solve the volume problem with **inbox rotation** — spreading sends across many warmed
mailboxes so each stays under its safe daily cap (10 mailboxes × 50/day = 500/day at the campaign level while
each inbox stays safe) ([Smartlead — Email Sending Frequency](https://www.smartlead.ai/blog/email-frequency-best-practices-for-cold-emails)).

### 6.2 Recommended for TruePoint

Enrollment is **not** "create N enrollments, send N emails now". Two independent throttles compose:

1. **Enrollment admission (ramp).** Adding contacts creates `email_enrollment` rows in state `active` with
   their first `next_action_at` **staggered** — not all set to "now". A per-sequence **daily admission cap**
   (default modest, e.g. start 20–50/day per mailbox, tenant-tunable) means a 5,000-contact enrollment drips
   in over many days rather than firing day one. New mailboxes ramp slower (this is the warmup ramp `02`
   owns — accounts <6 months old add ~1/day, older ones ~2/day per the sources). The engine reads the ramp
   schedule from `02`; it does not invent its own.
2. **Send admission (backpressure).** The actual sends flow through the **`email_send` queue (D10)** which is
   **backpressure-bounded** per the TruePoint queue contract — the fan-out is capped, with **per-tenant +
   per-mailbox throttling** (D10) and backoff+DLQ. So even if many enrollments become eligible at once, the
   send queue meters them out at the mailbox's safe rate; excess work waits in the queue rather than
   overwhelming a mailbox. This is exactly the "queue backpressure bounds fan-out" constraint from the digest.

Mailbox selection / rotation: an enrollment is bound to a `mailbox_integration_id` at admission; for a large
enrollment the engine can **rotate across the tenant's eligible mailboxes** (the Smartlead pattern) so total
throughput scales with mailbox count while each mailbox stays under its `02`-owned daily cap.

### 6.3 Tradeoffs

| Choice | Pro | Con / mitigation |
|---|---|---|
| Drip admission (staggered `next_action_at`) | Naturally ramps; never a day-one blast; respects mailbox caps. | A user expecting "send all today" must be told it drips — surface the projected completion date in `10`. |
| Backpressure via the `email_send` queue (D10) | Reuses the platform's bounded fan-out; no engine-local rate limiter to drift. | The send queue is shared; a giant enrollment could starve manual sends — mitigate with per-tenant fairness + priority lanes (a `02`/platform concern). |
| Mailbox rotation | Throughput scales with mailbox count; each inbox stays safe. | Rotation can split a thread across mailboxes — bind a *conversation* (same contact) to a stable mailbox; rotate only across *contacts*. |

---

## 7. The tick engine, the queue, and the leader-lock gap (D10)

### 7.1 How enrollments advance

A scheduled/repeatable worker — the **`email_sequence_tick` queue** (the fourth D10 queue, alongside
`email_send`, `email_tracking`, `email_warmup`) — wakes on an interval, and within a per-tenant job (workers
set `app.current_tenant_id`/`app.current_workspace_id` GUCs per job, per the tenancy contract) selects
`email_enrollment` rows where `state='active' AND next_action_at <= now()`, and for each:

1. Loads the current `email_sequence_step`; if a branch condition is set, re-reads `04` events at tick time
   (§3).
2. Dispatches by `step_type` (§2.2 table) — `email_auto` computes the send-window/jitter target (§4),
   re-checks the **D4 suppression gate**, and enqueues an **idempotent (D5)** `email_send`; task types create
   a task and wait.
3. Advances `current_step_order` and sets the next `next_action_at` from the next step's delay; if no next
   step, transitions `active → finished`.

The tick worker **never sends directly** — it only enqueues onto the bounded `email_send` queue (D10
backpressure, §6). Idempotency keys (`email_idempotency_key`, D5) are derived from
`(enrollment_id, step_order)` so a redelivered tick or a double-selected row cannot double-send the same step.

### 7.2 The known gap — CONFIRM LEADER-LOCKED SCHEDULER (directly relevant here)

The TruePoint constraints digest names an **open gap**: *"CONFIRM LEADER-LOCKED SCHEDULER for sequences"* — a
scheduled/repeatable job that ticks enrollments **must not double-fire across worker instances**. This is the
single most important correctness risk in this doc and it is called out per the self-check.

The contract (from the digest's Queues rules): **SCHEDULED/REPEATABLE jobs need a leader lock so a tick
doesn't double-fire.** Concretely, for `email_sequence_tick`:

- The repeatable *scheduler* (the thing that enqueues the periodic tick) must run as a **single leader** —
  BullMQ repeatable/cron jobs already de-duplicate the scheduling, but a multi-instance worker fleet must not
  each *also* schedule it. Use a leader election (e.g. a Redis lock / BullMQ's built-in repeatable-job
  dedupe by `jobId`) so exactly one instance owns the schedule.
- The *processing* of each enrollment must be **idempotent and row-locked**: select eligible enrollments with
  `FOR UPDATE SKIP LOCKED` (or claim via a status flip in-tx) so two workers processing the same batch can
  never both advance the same enrollment. Combined with the `(enrollment_id, step_order)` idempotency key
  (D5), a double-processed row at worst no-ops the send.
- **Defence in depth:** even if the scheduler *did* double-fire, the per-step idempotency key + the
  `FOR UPDATE SKIP LOCKED` claim mean the **send** cannot duplicate. The leader lock prevents wasted ticks and
  thundering-herd; idempotency prevents the user-visible harm.

> **Action for `09`/`13`/platform:** before Phase 4 ships, **confirm and document** the leader-lock mechanism
> (Redis-based election vs. BullMQ repeatable-job `jobId` dedupe) and add an integration test that runs the
> tick under two simulated workers and asserts no enrollment advances twice and no step double-sends. This is
> the resolution of the named gap; it is **not** optional polish.

### 7.3 File map

| Concern | Path |
|---|---|
| Sequence engine (tick logic, branch eval, scheduling) | `packages/core/src/email/` (sequence engine) |
| The tick queue + worker | `apps/workers/src/queues/email*.ts` (the `email_sequence_tick` queue) |
| Entities + RLS | `packages/db/src/schema/email.ts` + `rls/email.sql` + `repositories/emailRepository.ts` (owned by `09`) |
| API (`/api/v1` sequence CRUD, enroll, pause/resume) | `apps/api/src/features/email/{routes.ts,index.ts}` |
| Sequences tab | `apps/web/src/features/email/` (Sequences tab) |

---

## 8. Enrollment lifecycle — the state machine (D8 owner-scoped)

An `email_enrollment` is a small state machine. States and transitions (prose; `09` mints the enum).
Best-in-class analogue: Outreach's sequence states are `active`, `paused` (incl. `paused (OOO)`), and the
terminal `finished`, `bounced`, `opted_out`, `failed`, `disabled`
([Outreach — Sequence States Overview](https://support.outreach.io/hc/en-us/articles/211861917-Outreach-Sequence-States-Overview)).
TruePoint mirrors this:

| State | Meaning | Entered from | Exits to |
|---|---|---|---|
| `active` | Running; the tick engine advances it. | (admission) | `paused`, `finished`, `replied`, `bounced`, `unsubscribed`, `failed` |
| `paused` | Temporarily halted — by OOO (`resume_at`), soft-bounce spike, manual pause by owner, or a mailbox circuit breaker. | `active` | `active` (resume / `resume_at`), or terminal if owner ends it |
| `finished` | All steps completed, no terminal event fired (the "no reply" finish). | `active` | terminal |
| `replied` | Genuine reply detected (`04`). | `active` | terminal |
| `bounced` | Hard bounce (`04`); suppression written. | `active` | terminal |
| `unsubscribed` | Opt-out / List-Unsubscribe (`04`); **D9 — honoured mid-sequence**, suppression + consent revocation written. | `active` | terminal |
| `failed` | Unrecoverable send error after backoff/DLQ (D10), or a step misconfiguration (e.g. missing template). | `active` | terminal (owner may retry → `active`) |

```
                  admission (drip, §6)
                          │
                          ▼
   (resume / resume_at)  ┌──────────┐  reply ───────────────► replied  (terminal)
        ┌───────────────►│  active  │  hard bounce ─────────► bounced  (terminal, + suppression)
        │                └────┬─────┘  unsubscribe (D9) ────► unsubscribed (terminal, + suppression/consent)
        │   OOO / soft-spike /     │   all steps done ──────► finished (terminal)
        │   manual / breaker       │   send error (DLQ) ────► failed   (terminal; owner may retry)
        │                          ▼
        └──────────────────────  paused ──── owner ends ───► (terminal)
```

**Visibility (D8).** Enrollments are **owner-scoped**: by default an owner sees their own enrollments; the
list/sequence may be workspace-shared per the sharing model, but enrollment *contents* follow D8 owner-scope.
RLS keys on `workspace_id` (ENABLE+FORCE, fail-closed `NULLIF`); owner-vs-workspace visibility is the app
filter on top (the same posture lists use). A foreign or non-owned enrollment id resolves to **404, never a
leak** (IDOR→404, security rules). The tick worker runs each batch inside the tenant/workspace GUC context so
RLS scopes its selects too.

---

## 9. Cross-cutting guarantees (the locked decisions, applied)

| Decision | How this doc honours it |
|---|---|
| **D4** — suppression gate every send, fail-closed, **re-checked before each step** | §5.2 + §7.1: every `email_auto` step re-runs the suppression gate at send time; an event-driven auto-pause is the fast path, the per-step gate is the guarantee. |
| **D5** — sends idempotent | §3.2 / §4.2 / §7.1: per-step idempotency key from `(enrollment_id, step_order)`; persisted jitter + deterministic variant assignment so retries don't double-send or flip. |
| **D6** — opens informational, not a KPI | §3.2: a branch may *read* `opened` for a warmer follow-up but must not *gate* sending on it; `clicked`/`replied` are the reliable signals. |
| **D8** — owner-scoped visibility | §8: enrollments owner-scoped; IDOR→404; workers tenant-scoped per job. |
| **D9** — compliance, unsubscribe honoured mid-sequence | §5.2: `unsubscribed` is terminal *and* writes suppression+consent revocation; the per-step D4 gate enforces it even mid-flight. |
| **D10** — fan-out + ingestion queue-backed; per-tenant + per-mailbox throttling | §6/§7: tick enqueues onto the bounded `email_send` queue; `email_sequence_tick` is the scheduled queue; backpressure + per-mailbox throttle meter the drip. |
| Tenancy (RLS ENABLE+FORCE, GUCs, `tenant_id`-leading indexes) | §8: all three entities RLS-FORCED, workers set GUCs per job, `tenant_id`-leading indexes (`09`). |
| Queues (idempotent at-least-once, backoff+DLQ, **leader-locked scheduled jobs**) | §7.2: the named **leader-lock gap** is the must-resolve item; `failed` state captures DLQ exhaustion. |

---

## 10. Build checklist (the Phase-4 slice this doc owns)

Maps to `13 §P4` ("Sequences + automation: cadences, steps, branching, scheduling, auto-pause-on-reply,
throttled enrollment; web Sequences tab"). Depends on P1 send path, P2 templates, P3 tracking+inbox.

- [ ] **Engine entities** (`09`): `email_sequence`, `email_sequence_step`, `email_enrollment` with the
      step-type + state enums from §2/§8; RLS ENABLE+FORCE, fail-closed, `tenant_id`-leading indexes.
- [ ] **Tick worker** (`apps/workers/src/queues/email_sequence_tick`): repeatable scheduled job;
      `FOR UPDATE SKIP LOCKED` enrollment claim; per-step dispatch (§2.2); send via the `email_send` queue with
      D5 idempotency key from `(enrollment_id, step_order)`.
- [ ] **LEADER-LOCK** (§7.2 — the named gap): confirm + document the mechanism; add a two-worker integration
      test proving no double-tick / no double-send. **Blocking for P4.**
- [ ] **Send-window/timezone/cap/jitter scheduler** (§4): recipient-local windows, consume `02`'s per-mailbox
      daily cap, persisted jitter.
- [ ] **Auto-pause consumer** (§5): `04` reply/bounce/OOO/unsub events transition enrollments; OOO resume;
      mailbox circuit breaker; D9 unsubscribe writes suppression+consent.
- [ ] **Throttled enrollment** (§6): drip admission with per-sequence daily cap + `02` warmup ramp; mailbox
      rotation; backpressure via the `email_send` queue.
- [ ] **Branching + A/B** (§3): single condition/step reading `04` events; deterministic variant assignment;
      per-variant attribution handed to `08`.
- [ ] **API** (`apps/api/src/features/email/routes.ts`): `/api/v1` sequence CRUD + enroll + pause/resume,
      cursor pagination, Idempotency-Key on enroll, RFC 9457 envelope, owner-scoped (D8).
- [ ] **Verify** against `13 §P4`: build a 3-step cadence → enroll a cohort → it drips within mailbox caps in
      recipient-local windows → a reply auto-pauses (terminal `replied`) → an unsubscribe halts mid-sequence
      (D9) → no enrollment double-advances under two workers (leader-lock test green).

---

## Sources

- [Salesloft — Multi-Touch Cadence Workflows](https://help.salesloft.com/s/article/Multi-Touch-Cadence-Workflows?language=en_US)
- [Octave — How to Build High-Converting Salesloft Cadences](https://www.octavehq.com/post/how-to-build-high-converting-salesloft-cadences)
- [Apollo — Sequences Overview](https://knowledge.apollo.io/hc/en-us/articles/4409237165837-Sequences-Overview)
- [Outreach — A/B Testing Sequence Steps](https://support.outreach.io/hc/en-us/articles/205083718-A-B-Testing-Sequence-Steps-in-Outreach)
- [Apollo — Use an A/B Test in a Sequence](https://knowledge.apollo.io/hc/en-us/articles/4410749683597-Use-an-A-B-Test-in-a-Sequence)
- [MailAdept — Email Automation Guide (2026)](https://www.mailadept.com/email-automation)
- [Prospeo — Cold Email Time Zones: 2026 Guide](https://prospeo.io/s/cold-email-time-zone)
- [Zeliq — Best Days and Times to Send B2B Cold Emails in 2025](https://www.zeliq.com/blog/best-days-for-email-open-rates)
- [Smartlead — Email Sending Frequency for Cold Email](https://www.smartlead.ai/blog/email-frequency-best-practices-for-cold-emails)
- [Topo — Cold Email Sending Limits: The 2025 Playbook](https://www.topo.io/blog/safe-sending-limits-cold-email)
- [Smartlead — Cold Email Checklist (2025)](https://www.smartlead.ai/blog/cold-email-checklist)
- [ConnectSafely — When to Pause an Outreach Cadence (2026)](https://connectsafely.ai/articles/pause-cadences-cold-outreach-rules-2026)
- [Outreach — Bounce and Auto-Reply Detection](https://go-outreach.com/features/bounce-and-auto-reply-detection)
- [Apollo — Configure Email Sending Limits](https://knowledge.apollo.io/hc/en-us/articles/4409233349005-Configure-Email-Sending-Limits)
- [AI-Productivity — Apollo Sequences Automated Outreach (2026)](https://aiproductivity.ai/guides/apollo-sequences-automated-outreach/)
- [Outreach — Sequence States Overview](https://support.outreach.io/hc/en-us/articles/211861917-Outreach-Sequence-States-Overview)
