# Email — Sequences & Automation (05)

> **Reconciled to the shipped M9 engine (D11, doc `14`).** This doc was first written against the working
> names `email_sequence` / `email_sequence_step` / `email_enrollment`. Those are **not** new tables — they
> are the **already-shipped** `outreach_sequences` / `outreach_steps` / `outreach_log`
> (`packages/db/src/schema/outreach.ts`). Per **Locked Decision D11** (stated in full in `14 §6`), the
> sequence engine **EXTENDS** the M9 outreach engine; it must **not** introduce a parallel `email_*` stack.
> The vocabulary mapping is authoritative in `14 §2`; this doc uses the real names below:
>
> | Working name (former) | Real shipped name | Lives in | This doc |
> |---|---|---|---|
> | `email_sequence` (cadence definition) | **`outreach_sequences`** (`name`, `status` `active`\|`paused`\|`archived`, `from_address`, `physical_address`, `UNIQUE(workspace_id,name)`) | `packages/db/src/schema/outreach.ts` | REUSE — §1, §2 |
> | `email_sequence_step` (the touch) | **`outreach_steps`** (`step_order`, **`channel`** `email`\|`linkedin`, `delay_hours`, `subject`, `body`, `UNIQUE(sequence_id,step_order)`) | `outreach.ts` | REUSE — already multi-channel via `channel`; §2 |
> | `email_enrollment` (one run) | **`outreach_log`** (`status` `enrolled`\|`active`\|`replied`\|`completed`\|`unsubscribed`\|`bounced`, `current_step`, `last_event_at`, **`UNIQUE(sequence_id,contact_id)` = enrollment idempotency**) | `outreach.ts` | REUSE — §6, §8 |
> | the send transaction | **`core/outreach/sendStep.ts`** (CAN-SPAM-gated, re-runs `assertNotSuppressed` in-tx, auto-appends footer, sends via `EmailSenderPort`, advances `outreach_log`, audits) | `packages/core/src/outreach/` | REUSE — §2, §4, §7 |
> | enrollment create | **`core/outreach/enrollContact.ts`** (revealed-only + `assertNotSuppressed` in-tx + idempotent + `enroll` audit) | `core/outreach/` | REUSE — §6 |
> | bounce handling | **`core/outreach/handleBounce.ts`** (marks `bounced`, inserts workspace `suppression_list` row, ADR-0013 credit-back) | `core/outreach/` | REUSE — §5 |
> | suppression gate (D4) | **`suppression_list`** + **`compliance/assertNotSuppressed.ts`** | `billing.ts` / `core/compliance/` | REUSE — §5, §7 |
> | consent (D9) | **`consent_records`** | `compliance.ts` | REUSE — §5 |
> | idempotency (D5) | **`idempotency_keys`** (`UNIQUE(tenant_id,key)`) | `billing.ts` | REUSE — §3, §4, §7 |
> | engagement timeline | **`activities`** (`email_sent`\|`email_opened`\|`email_clicked`\|`email_replied`) + the new **`email_event`** raw store | `activity.ts` (+ new) | REUSE + NEW — §3, §5 |
>
> The tick worker **extends** `apps/workers/src/queues/outreach.ts` (`processOutreach` → `sendStep`); it is
> not a fresh worker file. **This is milestone M12 (extend M9), not a greenfield build** (`14 §5`). The
> scale design of the scheduler, the throttle, and the partitioned `email_event` store is owned by `15`
> (Part A); this doc cross-refs it at §7. **`outreach_steps.channel` already supports `email`\|`linkedin`**
> — a multi-channel seam (`15 §B.1`); this engine is described to **widen** off that enum, never hard-gated
> to email-only.
>
> Cites the **Shared Vocabulary**, the **Locked Decisions (D1–D11)**, the **Phase Map (P0–P6)** and the
> **Canonical Entities** fixed in `00-overview.md` — verbatim, not re-litigated. This doc owns the
> **sequence engine**: how a multi-touch cadence is modelled, ticked, branched, scheduled, auto-paused, and
> enrolled into without overwhelming a mailbox. It is the customer-facing automation layer; the entities it
> describes (`outreach_sequences`, `outreach_steps`, `outreach_log`) are **owned by `09-data-model.md`** and
> reconciled to the real schema in `14 §2`; this doc proposes their behaviour, not their final DDL. Sibling
> docs it leans on:
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

TruePoint adopts this model on the **three already-shipped M9 tables** (owned by `09`, reconciled in
`14 §2`; RLS-FORCED, `tenant_id` always, `workspace_id` workspace-scoped; D8 owner-vs-workspace visibility
is the app filter on top, §8):

| Entity (real table) | Role | Real + proposed columns (`09` finalizes any additive ones) |
|---|---|---|
| **`outreach_sequences`** (was `email_sequence`) | The cadence definition: name, status (`active`/`paused`/`archived`), the CAN-SPAM `from_address` + `physical_address` the send tx enforces; **proposed additive**: default send-window + timezone policy, per-mailbox throttle hints. | (real) `id`, `tenant_id`, `workspace_id`, `name`, `status`, `from_address`, `physical_address`, `created_by_user_id`, `created_at`, `updated_at`, `UNIQUE(workspace_id,name)`; (proposed) `send_window`, `timezone_mode`, `daily_cap` |
| **`outreach_steps`** (was `email_sequence_step`) | One ordered touch: **`channel`** (already `email`\|`linkedin` — the multi-channel seam, `15 §B.1`), the subject/body it renders (today inline; a versioned `email_template` slots in per `01`), delay-from-previous; **proposed additive**: branch rule, A/B variant group. | (real) `id`, `tenant_id`, `workspace_id`, `sequence_id`, `step_order`, `channel`, `delay_hours`, `subject`, `body`, `created_at`, `UNIQUE(sequence_id,step_order)`; (proposed) `step_type`, `branch_*`, `variant_group` |
| **`outreach_log`** (was `email_enrollment`) | One prospect's run **through** a sequence: status, current step, last event; **`UNIQUE(sequence_id,contact_id)` is the enrollment idempotency** (the same constraint `enrollContact.ts` is idempotent against). **Proposed additive**: the mailbox it sends from, the parked next-tick instant, pause reason. | (real) `id`, `tenant_id`, `workspace_id`, `sequence_id`, `contact_id`, `status`, `current_step`, `last_event_at`, `created_at`, `UNIQUE(sequence_id,contact_id)`; (proposed) `mailbox_integration_id`, `next_action_at`, `paused_reason`, `finished_at` |

A **send** produced by a step goes through **`core/outreach/sendStep.ts`** — the one shipped send
transaction (the same idempotent, CAN-SPAM-gated, suppression-gated, tracked send `02`/`04`/`14 §1.2`
define). The sequence engine does **not** invent a second send path; it composes the existing one. This
matters for D4 (suppression gate fires on *every* send via in-tx `assertNotSuppressed`), D5 (every send
idempotent against `idempotency_keys`), and D10 (the send still fans out through the `email_send` queue).
**D11 forbids a parallel send/enroll path** precisely so the fail-closed D4 gate and the D5 constraint
cover every send (`14 §6`).

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

Model a sequence as an **ordered list of `outreach_steps` rows** (`step_order` ascending). The shipped step
already carries **`channel`** (`email`\|`linkedin`) and **`delay_hours`**; `09` adds an additive `step_type`
to distinguish auto-send from task steps, and the engine reads `channel` to **route** a due step to the
channel-appropriate handler (`15 §B.1`) rather than hard-coding email. A `delay_hours = 0` step is the
"due immediately after previous" multi-touch case. The **step-type table** (the contract for what an engine
tick does at each step):

| `step_type` (additive on `outreach_steps`) | What the engine does on tick | Produces | Notes |
|---|---|---|---|
| `email_auto` (`channel='email'`) | Renders the step's subject/body (the inline fields today; a versioned `email_template` per `01`) for the contact's mailbox, then hands off to **`core/outreach/sendStep.ts`** — which re-runs the **D4 `assertNotSuppressed` gate in-tx**, auto-appends the CAN-SPAM footer, and sends via `EmailSenderPort` — enqueued idempotently (D5, `idempotency_keys`) onto the `email_send` queue (D10). | an `outreach_log` advance + a tracked send | The only step type that sends automatically. Subject to send-window, timezone, daily-cap, jitter (§4). |
| `email_manual` | Drafts the email and creates a **task** for `owner_user_id` to review + send (the "personalize" touch). No auto-send. | task | Engine waits on task completion before advancing. |
| `call_task` | Creates a manual **call task** for the owner; engine pauses the enrollment's auto-advance until the task is marked done/skipped. | task | TruePoint dialer integration is out-of-scope here; this is a to-do. |
| `linkedin_task` | Creates a manual **LinkedIn task** (connect / message). | task | Manual; no LinkedIn automation (compliance + ToS). |
| `wait` | Pure delay node — no touch. Used to widen the gap between touches without a separate action. | — | Lets the timing-shape (front-load then widen) be modelled explicitly. |

**Channel scope at launch — and the seam to widen.** `outreach_steps.channel` is **already** an enum with
`email`\|`linkedin` (`14 §1.1`, `14 §6`, `15 §B.1`): the cadence model is **channel-aware today**; the M9
engine simply only *handles* `email` so far. Phase 4 ships the engine with **email steps fully automated**
(`email_auto`, `email_manual`) routed to `sendStep`/`EmailSenderPort`, and **non-email steps as tasks**
(`call_task`, `linkedin_task`, `wait`). This matches the "email scales, phone/LinkedIn are human moments"
reality and keeps the **automated** blast radius to the one channel TruePoint owns end-to-end (the mailbox).
But this is a **routing decision, not a schema gate**: because the engine dispatches by `outreach_steps.channel`,
adding a `linkedin` (later `sms`/`call`) **send** handler is enum-already-present + one handler in the
routing layer (`15 §B.1`) — **not** a new sequence/step/enrollment model. Each new channel inherits the D4
suppression gate (`suppression_list.match_type` already includes `phone`), D5 idempotency, and D8 ownership
unchanged. The plan must **widen** off `channel`; it must never hard-code an email-only path that would have
to be unforked later.

### 2.3 Tradeoffs

| Choice | Pro | Con / mitigation |
|---|---|---|
| Day-delay between steps (not absolute dates) | Sequence definition is reusable across enrollments enrolled on different days. | "Send on March 3" campaigns need a `wait` + send-window; acceptable, those are rare in outbound. |
| Non-email steps as manual tasks | No ToS/automation risk on LinkedIn; reps keep human judgement on calls. | Sequence can stall on an un-actioned task — surface overdue tasks in `10`; allow auto-skip-after-N-days as a per-step option. |
| One send path reused (`core/outreach/sendStep.ts`, D11) | D4/D5/D10 guarantees inherited for free; one place to audit; no second, weaker path the gate doesn't cover (`14 §6`). | Engine must compose, not bypass, the send tx + `email_send` queue — slightly more orchestration (§7). |

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
skip to step N); else continue." Branch facts come **only** from the **`activities`** engagement timeline
(`email_opened`/`email_clicked`/`email_replied`, fed by the raw `email_event` store, `04`/`14 §2`) — never a
client-asserted "opened". The engine re-reads `activities` at tick time.

> **D6 guardrail.** Opens are **informational, not a KPI** (D6). A branch *may* read `opened` to pick a
> warmer follow-up, but the engine must **not** make `opened` a *gating* signal for whether to send at all
> (a missed open-pixel must never silently halt a real follow-up). `clicked` and `replied` are reliable;
> `opened` is best-effort. Document this on each branch in the builder (`10`).

**A/B variants.** Model variants as multiple `outreach_steps` rows sharing a `variant_group` id with a split
**`weight`** (the additive A/B primitive `15 §B.4` names), or a `variants[]` array on one step (`09` picks the
shape). At enrollment-creation the engine **deterministically assigns** a variant from the `outreach_log`
enrollment id (stable hash → no flip-flop on retry, D5-safe) and records the chosen variant/`template_version_id`
on the resulting send (the `activities` row + audit) so `08` can attribute sends/clicks/replies per variant.
Splits default 50/50; a tenant may promote a winner (point both weights at the winning variant) without
restructuring the sequence. MVT/bandit allocation is a later extension **on top of** the same `weight` field
(`15 §B.4`), not a new model.

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
computes the **earliest valid send instant** and parks the `outreach_log` row's `next_action_at` (additive)
there:

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

Auto-pause is **event-driven**, not polled. The tracking ingestion (`04`, D10) already classifies inbound
into the **`activities`** timeline (`email_replied`, bounce, unsubscribe, OOO — fed by the raw `email_event`
store, `14 §2`). The hard-bounce → suppression → credit-back loop is **already shipped** in
**`core/outreach/handleBounce.ts`** (marks the `outreach_log` row `bounced`, inserts a workspace
`suppression_list` row, runs the ADR-0013 credit-back, `14 §1.2`). When `04` ingests one of these for a
contact that has a **live `outreach_log` enrollment**, it transitions that enrollment (this is the one place
the engine reacts to inbound, not the tick):

| Inbound event (from `04`/`activities`) | `outreach_log` transition | Resume behaviour |
|---|---|---|
| `replied` (genuine reply, `email_replied` activity) | `active → replied` (terminal) | None — a human takes over. |
| `bounced` (hard) | `active → bounced` (terminal) via **`handleBounce.ts`** | None; the same tx inserts a workspace `suppression_list` row (D4/`06`) + ADR-0013 credit-back so it can't be re-sent. |
| `bounced` (soft) | stay `active`, increment a soft-bounce counter | After N soft bounces or a sender-level spike threshold, escalate to `paused` (reason `soft_bounce_spike`). |
| `unsubscribed` (or List-Unsubscribe / opt-out) | `active → unsubscribed` (terminal) | None — **D9: unsubscribe is honoured mid-sequence**; a `suppression_list` row + a `consent_records` withdrawal (`withdrawn_at`) is written so no future step or sequence can send. |
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

1. **Enrollment admission (ramp).** Adding contacts goes through **`core/outreach/enrollContact.ts`**
   (revealed-only, `assertNotSuppressed` in-tx, idempotent against `UNIQUE(sequence_id,contact_id)`, `enroll`
   audit) — creating `outreach_log` rows in state `active` with their first `next_action_at` **staggered** —
   not all set to "now". A per-sequence **daily admission cap**
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
`email_send`, the tracking-ingestion queue, and `email_warmup`) — **extends the shipped
`apps/workers/src/queues/outreach.ts`** (`processOutreach` → `sendStep`, `14 §1.3`); it is **not** a fresh
worker. It wakes on a fixed cadence, and within a per-tenant job (workers set
`app.current_tenant_id`/`app.current_workspace_id` GUCs per job, per the tenancy contract) selects due
**`outreach_log`** rows where `status='active' AND next_action_at <= now()`, and for each:

1. Loads the current **`outreach_steps`** row; if a branch condition is set, re-reads the **`activities`**
   timeline at tick time (§3).
2. Dispatches **by `outreach_steps.channel` + `step_type`** (§2.2 table) — `email_auto` computes the
   send-window/jitter target (§4) and hands off to **`core/outreach/sendStep.ts`**, which re-runs the **D4
   `assertNotSuppressed` gate in-tx**, appends the CAN-SPAM footer, and sends via `EmailSenderPort`, enqueued
   **idempotently (D5)** onto the `email_send` queue; task types create a task and wait. (Routing by `channel`
   is the multi-channel seam — `15 §B.1`.)
3. Advances `outreach_log.current_step` + `last_event_at` and sets the next `next_action_at` from the next
   step's `delay_hours`; if no next step, transitions `active → completed`.

The tick worker **never sends directly** — it only claims rows and enqueues onto the bounded `email_send`
queue (D10 backpressure, §6); the send tx is the single shipped `sendStep`. Idempotency keys
(**`idempotency_keys`**, D5) are derived from `(sequence_id, contact_id, step_order)` — i.e. the
`outreach_log` enrollment + step — so a redelivered tick or a double-claimed row cannot double-send the same
step.

### 7.2 The leader-locked scheduler — fully specified (resolves known-gap #5)

The TruePoint constraints digest named an **open gap**: *"CONFIRM LEADER-LOCKED SCHEDULER for sequences"* —
the scheduled job that ticks `outreach_log` enrollments **must not double-fire across worker instances**, or
a double-fire is a **duplicate email to a real recipient** (`13 §6` known-gap #5, `15 §A.4`). This is the
single most dangerous worker in the subsystem; the design is **specified here in full**, and the scale-side
detail is owned by **`15 §A.4`** (which this section mirrors, not re-litigates).

**(1) Single-fire via a leader lock.** Exactly **one** tick instance does the due-scan per cadence. Either
mechanism is acceptable; the *contract* is single-fire, not the mechanism:

- **Redis leader election** — a short-TTL Redis lock the active instance acquires and **renews** on each
  tick; on its failure another instance takes the lock after TTL expiry, so the fleet always has exactly one
  active scheduler. Or
- **BullMQ repeatable job with a stable `jobId`** — the queue itself de-duplicates the schedule by `jobId`,
  so a multi-instance fleet that all register the repeatable job still yields **one** scheduled instance.

**(2) Tick frequency.** A bounded cadence — **once per minute** is the baseline: frequent enough that a step
due "now" fires within the product's promised resolution, infrequent enough that the due-scan stays cheap.
Tick frequency is a **config, not code** (`15 §A.4`, `§B.2` posture), so it can be tuned per environment.

**(3) `FOR UPDATE SKIP LOCKED` batch cap.** The due-scan claims a **bounded batch** of due `outreach_log`
rows with `SELECT … FOR UPDATE SKIP LOCKED LIMIT {cap}` inside the per-tenant GUC context. This does two
things at once: (a) even if — against the leader lock — two scanners run, they claim **disjoint** rows and
can **never advance the same enrollment twice**; and (b) a single tick can **never** enqueue an unbounded
fan-out that starves the `email_send` queue (`15 §A.8` queue isolation). The claimed rows advance
`current_step` / `last_event_at` on `outreach_log` **in the same transaction** as the claim.

**(4) Idempotency backstop (defence in depth).** Every enqueued step still carries the
`(sequence_id, contact_id, step_order)` Idempotency-Key into the send path (D5, `idempotency_keys`), so even
a pathological double-claim cannot produce a second send. The leader lock prevents wasted ticks and a
thundering herd; the `FOR UPDATE SKIP LOCKED` claim prevents a double-advance; the idempotency key prevents
the user-visible duplicate send. **Three independent guards** stand between a fleet race and a duplicate
email.

**(5) The mandatory two-worker no-double-advance itest (P4 "Done when").** Run **two `email_sequence_tick`
instances** against the same seeded `outreach_log` enrollments and assert **each due step advances exactly
once and produces exactly one send**. This is the structural proof behind known-gap #5; it extends the
cross-tenant isolation itest family (`13 §7`, `15 §A.4`) and runs in CI (Docker / Postgres / Redis). It is a
**hard gate**: the leader-lock + batch-claim must pass it **before `email.sequences` is enabled for any
tenant** (`13 §3`).

> **Action for `09`/`13`/`15`/platform:** **confirm and document** the chosen mechanism (Redis election vs.
> BullMQ `jobId` dedupe), the **once-per-minute** tick config, and the `FOR UPDATE SKIP LOCKED` batch cap on
> the **`outreach.ts`** worker; land the **two-worker itest** above. This is the resolution of known-gap #5
> — **not** optional polish, and **blocking for P4** (§10).

### 7.3 File map (real paths — `14 §1`)

| Concern | Path (shipped / extend) |
|---|---|
| Sequence/enroll/send/bounce logic (create, enroll, tick dispatch, branch eval, scheduling) | **`packages/core/src/outreach/`** — `createSequence.ts`, `enrollContact.ts`, **`sendStep.ts`** (the send tx), `handleBounce.ts`, `senderPort.ts` (the `EmailSenderPort` seam) — **extend, don't replace** |
| The tick queue + worker | **`apps/workers/src/queues/outreach.ts`** (`processOutreach` → `sendStep`; the `email_sequence_tick` repeatable job + `FOR UPDATE SKIP LOCKED` claim extend this file) |
| Entities + RLS | **`packages/db/src/schema/outreach.ts`** (`outreach_sequences`/`outreach_steps`/`outreach_log`) + `repositories/{outreachLogRepository,suppressionRepository,creditRepository}.ts` (owned by `09`, RLS posture `14 §5`) |
| API (`/api/v1/outreach` sequence CRUD, enroll, pause/resume) | **`apps/api/src/features/outreach/routes.ts`** (`GET/POST /sequences`, `POST /sequences/:id/steps`, `POST /sequences/:id/enroll` [201/200], `/enroll-bulk`, `GET /sequences/:id/log`, `POST /log/:id/send`, `POST /log/:id/bounce`) |
| Sequences tab | **`apps/web/src/features/sequences/`** — `SequenceList`, `SequenceBuilder`, `EnrollmentPanel`, `EnrollmentLogTable`, `SendStatusDashboard` (fully built, `14 §1.4`); vanilla React + `fetchWithAuth` + `MaybeList` + `StateSwitch` (`14 §3`), **not** TanStack Query |

---

## 8. Enrollment lifecycle — the state machine (D8 owner-scoped)

An **`outreach_log`** row is a small state machine on its `status` column. The **shipped** enum is
`enrolled` \| `active` \| `replied` \| `completed` \| `unsubscribed` \| `bounced` (`14 §1.1`); the
`paused`/`failed` states below are **additive** (`09` extends the enum). Best-in-class analogue: Outreach's
sequence states are `active`, `paused` (incl. `paused (OOO)`), and the terminal `finished`, `bounced`,
`opted_out`, `failed`, `disabled`
([Outreach — Sequence States Overview](https://support.outreach.io/hc/en-us/articles/211861917-Outreach-Sequence-States-Overview)).
TruePoint mirrors this on the real `outreach_log.status` enum (`finished` ≙ the shipped `completed`):

| `outreach_log.status` | Shipped? | Meaning | Entered from | Exits to |
|---|---|---|---|---|
| `enrolled` | shipped | Admitted by `enrollContact.ts`, not yet ticked. | (admission) | `active` |
| `active` | shipped | Running; the tick engine advances it. | `enrolled`, `paused` | `paused`, `completed`, `replied`, `bounced`, `unsubscribed`, `failed` |
| `paused` | **additive** | Temporarily halted — by OOO (`resume_at`), soft-bounce spike, manual pause by owner, or a mailbox circuit breaker. | `active` | `active` (resume / `resume_at`), or terminal if owner ends it |
| `completed` | shipped | All steps completed, no terminal event fired (the "no reply" finish). | `active` | terminal |
| `replied` | shipped | Genuine reply detected (`04`/`activities` `email_replied`). | `active` | terminal |
| `bounced` | shipped | Hard bounce via `handleBounce.ts`; `suppression_list` row written + ADR-0013 credit-back. | `active` | terminal |
| `unsubscribed` | shipped | Opt-out / List-Unsubscribe (`04`); **D9 — honoured mid-sequence**, `suppression_list` + `consent_records` withdrawal written. | `active` | terminal |
| `failed` | **additive** | Unrecoverable send error after backoff/DLQ (D10), or a step misconfiguration (e.g. missing template). | `active` | terminal (owner may retry → `active`) |

```
                  admission (enrollContact.ts, drip §6) → enrolled → active
                          │
                          ▼
   (resume / resume_at)  ┌──────────┐  reply ───────────────► replied   (terminal)
        ┌───────────────►│  active  │  hard bounce ─────────► bounced   (terminal, handleBounce + suppression)
        │                └────┬─────┘  unsubscribe (D9) ────► unsubscribed (terminal, + suppression/consent)
        │   OOO / soft-spike /     │   all steps done ──────► completed (terminal)
        │   manual / breaker       │   send error (DLQ) ────► failed    (terminal; owner may retry)
        │                          ▼
        └──────────────────────  paused ──── owner ends ───► (terminal)
```

**Visibility (D8).** `outreach_log` enrollments are **owner-scoped**: by default an owner sees their own
enrollments; the list/sequence may be workspace-shared per the sharing model, but enrollment *contents*
follow D8 owner-scope. RLS keys on `workspace_id` (ENABLE+FORCE, fail-closed `NULLIF`); owner-vs-workspace
visibility is the app filter on top (the same posture lists use). A foreign or non-owned `outreach_log` id
resolves to **404, never a leak** (IDOR→404, security rules). The tick worker runs each batch inside the
tenant/workspace GUC context so RLS scopes its selects too.

---

## 9. Cross-cutting guarantees (the locked decisions, applied)

| Decision | How this doc honours it |
|---|---|
| **D4** — suppression gate every send, fail-closed, **re-checked before each step** | §5.2 + §7.1: every `email_auto` step re-runs the suppression gate at send time; an event-driven auto-pause is the fast path, the per-step gate is the guarantee. |
| **D5** — sends idempotent | §3.2 / §4.2 / §7.1: per-step idempotency key from `(sequence_id, contact_id, step_order)` against `idempotency_keys`; persisted jitter + deterministic variant assignment so retries don't double-send or flip. |
| **D6** — opens informational, not a KPI | §3.2: a branch may *read* `opened` for a warmer follow-up but must not *gate* sending on it; `clicked`/`replied` are the reliable signals. |
| **D8** — owner-scoped visibility | §8: `outreach_log` enrollments owner-scoped; IDOR→404; workers tenant-scoped per job. |
| **D9** — compliance, unsubscribe honoured mid-sequence | §5.2: `unsubscribed` is terminal *and* writes a `suppression_list` row + `consent_records` withdrawal; the per-step D4 `assertNotSuppressed` gate enforces it even mid-flight. |
| **D10** — fan-out + ingestion queue-backed; per-tenant + per-mailbox throttling | §6/§7: tick enqueues onto the bounded `email_send` queue; `email_sequence_tick` is the scheduled queue extending `outreach.ts`; throttle is Redis + queue-local (`15 §A.1`), not a hot DB row; backpressure meters the drip. |
| **D11** — build on M9, don't duplicate | Whole doc: cadences = `outreach_sequences`/`outreach_steps`, enrollment = `outreach_log`, send = `sendStep.ts`, bounce = `handleBounce.ts`, gate = `suppression_list`+`assertNotSuppressed`, idempotency = `idempotency_keys` — **no parallel `email_*` tables** (`14 §6`). |
| Tenancy (RLS ENABLE+FORCE, GUCs, `tenant_id`-leading indexes) | §8: the three `outreach_*` tables RLS-FORCED, workers set GUCs per job, `tenant_id`-leading indexes (`09`, `14 §5`). |
| Queues (idempotent at-least-once, backoff+DLQ, **leader-locked scheduled jobs**) | §7.2: the leader-lock is **fully specified** (Redis election / BullMQ `jobId`, once-per-minute tick, `FOR UPDATE SKIP LOCKED` batch cap, two-worker no-double-advance itest — `15 §A.4`); `failed` captures DLQ exhaustion. |

---

## 10. Build checklist (the Phase-4 slice this doc owns)

Maps to `13 §P4` ("Sequences + automation: cadences, steps, branching, scheduling, auto-pause-on-reply,
throttled enrollment; web Sequences tab"). **This is M12 extending M9 — the entities, send tx, enroll path,
and bounce loop already ship (`14 §1`); the work below is additive on them, not greenfield.** Depends on P1
send path, P2 templates, P3 tracking+inbox.

- [ ] **Engine entities — EXTEND, not create** (`09`): the cadence/step/enrollment tables **already exist** as
      `outreach_sequences` / `outreach_steps` / `outreach_log` (`packages/db/src/schema/outreach.ts`, `14 §2`).
      Add only the additive columns from §2/§8 (`step_type`/`branch_*`/`variant_group` on steps;
      `next_action_at`/`paused_reason`/`mailbox_integration_id` + `paused`/`failed` status values on the log).
      **No new `email_sequence`/`email_sequence_step`/`email_enrollment` table** (D11). RLS already
      ENABLE+FORCE, `tenant_id`-leading.
- [ ] **Tick worker** (extend `apps/workers/src/queues/outreach.ts`, the `email_sequence_tick` repeatable job):
      `FOR UPDATE SKIP LOCKED LIMIT {cap}` claim on due `outreach_log` rows; per-step dispatch by
      `outreach_steps.channel`+`step_type` (§2.2); send via `sendStep.ts` → `email_send` queue with the D5
      idempotency key from `(sequence_id, contact_id, step_order)`.
- [ ] **LEADER-LOCK — fully specified** (§7.2, `15 §A.4` — resolves known-gap #5): confirm the mechanism
      (Redis election / BullMQ `jobId`), the **once-per-minute** tick config, the batch cap; add the
      **two-worker no-double-advance itest** (each due step advances exactly once, exactly one send).
      **Blocking for P4** and for enabling `email.sequences` for any tenant (`13 §3`).
- [ ] **Send-window/timezone/cap/jitter scheduler** (§4): recipient-local windows, consume `02`'s per-mailbox
      daily cap (Redis throttle, `15 §A.1`), persisted jitter on `outreach_log.next_action_at`.
- [ ] **Auto-pause consumer** (§5): `04`/`activities` reply/bounce/OOO/unsub events transition `outreach_log`;
      hard bounce via the shipped `handleBounce.ts`; OOO resume; mailbox circuit breaker; D9 unsubscribe writes
      `suppression_list` + `consent_records` withdrawal.
- [ ] **Throttled enrollment** (§6): drip admission via `enrollContact.ts` with per-sequence daily cap + `02`
      warmup ramp; mailbox rotation; backpressure via the `email_send` queue (`15 §A.8` isolation).
- [ ] **Branching + A/B** (§3): single condition/step reading `activities`; deterministic variant assignment
      keyed on the `outreach_log` id; per-variant attribution (the `weight` field, `15 §B.4`) handed to `08`.
- [ ] **API** (extend `apps/api/src/features/outreach/routes.ts`, `/api/v1/outreach`): the sequence CRUD +
      enroll (`201`/`200`) + log endpoints **already ship** (`14 §1.3`); add **pause/resume**, cursor
      pagination, Idempotency-Key on enroll, RFC 9457 envelope, owner-scoped (D8).
- [ ] **Verify** against `13 §P4`: build a 3-step cadence → enroll a cohort → it drips within mailbox caps in
      recipient-local windows → a reply auto-pauses (terminal `replied`) → an unsubscribe halts mid-sequence
      (D9, `suppression_list`+`consent_records`) → **no `outreach_log` enrollment double-advances under two
      workers** (the §7.2 / `15 §A.4` leader-lock itest green).

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
