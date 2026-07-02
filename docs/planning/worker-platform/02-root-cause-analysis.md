# Root Cause Analysis - Stuck Queued / Awaiting Confirmation

> **Scope.** This document explains, at the code level, why the Data-Ops dashboard shows
> **`Queued: 4`, `Awaiting Confirmation: 1`** and why those rows will not advance on their own. It
> traces the full 8-status `enrichment_jobs` lifecycle, walks the creation-to-execution path of each
> of the 5 stuck rows, ranks the causes, and separates **by-design safe-by-default darkness** from
> **genuine defects**. The live-environment procedure to rule out the genuine failure modes lives in
> [03-live-inspection-runbook.md](03-live-inspection-runbook.md). Sibling context:
> [00-executive-summary.md](00-executive-summary.md),
> [01-current-architecture-audit.md](01-current-architecture-audit.md),
> [04-issue-resolution-plan.md](04-issue-resolution-plan.md),
> [09-reliability-fault-tolerance.md](09-reliability-fault-tolerance.md),
> [13-operational-runbooks.md](13-operational-runbooks.md).

---

## 1. The verdict (lead with this)

**`Queued: 4` and `Awaiting Confirmation: 1` are almost certainly BY DESIGN, not a broken worker.**

These are not BullMQ queue depths. They are `count(*)` tallies of rows in the **database control
table `enrichment_jobs`, grouped by `status`** (`packages/db/src/repositories/platformAdminReads.ts:549-554`).
The entire bulk-enrichment money path that produces them is deliberately **dark** behind a three-part
safety envelope:

1. a deploy-time env kill-switch `BULK_ENRICHMENT_ENABLED` (default OFF),
2. a per-tenant rollout flag `bulk_enrichment_enabled` (seeded `global_enabled=false, default=false`), and
3. a human **confirm-before-spend** gate (owner/admin only).

With the kill-switch off — the default — a bulk-enrich submission is intentionally created as an
**inert orphan**. The source comment states this literally:

> "BULK_ENRICHMENT_ENABLED OFF (default): BYTE-IDENTICAL to the shipped behaviour — the row is
> created `queued`. Nothing consumes `queued` bulk-enrich jobs, so it stays an inert orphan exactly
> as today (no worker, no spend)." — `packages/core/src/prospect/bulkActions.ts:330-332`

So four `queued` rows is exactly what a correctly-functioning, feature-flagged-off system produces
when a user has clicked "bulk re-enrich" four times. One `awaiting_confirmation` row is a job that
was submitted while the flag was ON but is **waiting for a human to click confirm** — its intended
resting state.

**This does not, by itself, prove the worker is healthy.** Three genuine failure modes present as
similar symptoms and must be ruled out on the live environment (worker never booted, Redis wedged,
boot crash from an unrelated missing env var). Those are catalogued in
[§8](#8-genuine-failure-modes-to-rule-out-not-the-reported-symptom) and turned into commands in
[03-live-inspection-runbook.md](03-live-inspection-runbook.md).

**Explicitly ruled out:** the coord-bus agent-orchestration protocol is *not* the source of these
counts. Its task states are `pending → claimed → in_progress → done → in_review → approved → merged`
(+ `blocked`), it has no `Queued`/`Awaiting Confirmation` states, and it stores state in an MCP
server, not the DB (`tools/coord-bus/COORDINATION.md:22-24`). See
[01-current-architecture-audit.md](01-current-architecture-audit.md) for the full ruling.

---

## 2. Two different "queues" — never conflate them

| Layer | What it is | Where `queued`/`awaiting_confirmation` live | Citation |
|---|---|---|---|
| **DB control table** | `enrichment_jobs` — one row per submitted bulk re-enrich job; carries the lifecycle `status` | **Here.** The dashboard reads this. | `packages/db/src/schema/enrichmentJobs.ts:41-78` |
| **BullMQ queue** | The `"bulk-enrichment"` Redis queue that actually runs work | **Not here.** BullMQ has its own internal states (waiting/active/completed/failed). | `packages/types/src/bulkEnrichment.ts:15` (queue name) |

The dashboard counts are 100% the **DB control table**. A `queued` control row does **not** imply
any BullMQ job exists — in fact, for a `queued` bulk-enrich row, no BullMQ job is ever created (see
[§6](#6-the-non-atomic-enqueue-gap-how-a-running-job-can-have-no-work)). Conflating the two is the
single most common misdiagnosis of this dashboard.

---

## 3. The 8-status lifecycle

### 3.1 The closed vocabulary (declared three times, in mirror)

There is exactly one status vocabulary, declared redundantly across the stack so the DB, the API
contract, and the UI cannot drift:

| Layer | Values source | Citation |
|---|---|---|
| DB CHECK constraint (control row) | `queued, estimating, awaiting_confirmation, running, paused, completed, failed, cancelled` | `packages/db/src/schema/enrichmentJobs.ts:73-76` (column + default `queued` at `:50`) |
| DB CHECK constraint (chunk row) | same 8 values | `packages/db/src/schema/enrichmentJobs.ts:101-104` |
| Zod enum (`@leadwolf/types`) | same 8 values | `packages/types/src/bulkEnrichment.ts:71-81` |
| UI labels | `Queued … Cancelled` | `apps/web/src/features/enrichment-jobs/components/format.ts:49-58` |
| UI badge tones | `awaiting_confirmation → warning`, `queued → muted`, `paused → warning`, `failed → danger` | `apps/web/src/features/enrichment-jobs/components/format.ts:65-74` |

### 3.2 State diagram (as-built)

```mermaid
stateDiagram-v2
    direction LR
    [*] --> queued: submit, flag OFF (default)\nbulkActions.ts:354
    [*] --> estimating: submit, flag ON\nbulkActions.ts:354

    estimating --> awaiting_confirmation: setEstimateAwaitingConfirmation\n(guarded WHERE status='estimating')\nenrichmentJobRepository.ts:331-345

    awaiting_confirmation --> running: confirmAwaitingJob (HUMAN confirm)\n(guarded WHERE status='awaiting_confirmation')\nenrichmentJobRepository.ts:354-365

    running --> completed: empty job (runBulkEnrich.ts:98-104)\nOR last chunk (bulkProcessEnrichChunk.ts:217-226)
    running --> paused: brake trips (unguarded)\nbulkProcessEnrichChunk.ts:206-210

    paused --> running: NO WIRED PATH — trap state\n(runBulkEnrich guards status=='running', ts:71)

    completed --> [*]

    note left of queued
        DEAD END. No queued --> * transition exists in code.
        Inert orphan by design when flag OFF (bulkActions.ts:330-332).
    end note
    note right of paused
        TRAP. Nothing flips paused --> running.
    end note
    note right of failed
        DEAD. In the enum/UI/DTOs, but no production
        code writes 'failed' for enrichment_jobs.
    end note
    note right of cancelled
        DEAD. Same as failed — declared, never written.
    end note
```

Reading the diagram:

- There are **two entry lanes**. The flag decides which. `queued` and the `estimating → …` lane are
  mutually exclusive at submit time.
- The **only** path to a spending run is the diagonal `estimating → awaiting_confirmation → running`,
  each step **guarded** (status pinned in the SQL `WHERE`) and the last step gated behind a human.
- `queued`, `paused`, `failed`, `cancelled` are all **terminal-in-practice**: no code advances a job
  out of them (details in [§5](#5-dead-and-trap-states-queued-paused-failed-cancelled)).

### 3.3 Transition table (exact code, `path:line`)

| # | From → To | Trigger | Guard? | Writer (`path:line`) |
|---|---|---|---|---|
| T1 | `∅ → queued` | Submit while `BULK_ENRICHMENT_ENABLED` **off** | n/a (insert) | `packages/core/src/prospect/bulkActions.ts:354` (insert `:347-357`); schema default `packages/db/src/schema/enrichmentJobs.ts:50` |
| T2 | `∅ → estimating` | Submit while flag **on** | n/a (insert) | `packages/core/src/prospect/bulkActions.ts:354` (`status: enabled ? "estimating" : "queued"`) |
| T3 | `estimating → awaiting_confirmation` | Persist worst-case ceiling, arm gate | **Guarded** `WHERE status='estimating'` | `packages/db/src/repositories/enrichmentJobRepository.ts:331-345`; caller `packages/core/src/prospect/bulkActions.ts:361` |
| T4 | `awaiting_confirmation → running` | **Human** confirm; stamps `started_at=now()` | **Guarded** `WHERE status='awaiting_confirmation'` | `packages/db/src/repositories/enrichmentJobRepository.ts:354-365`; via `packages/core/src/enrichment/confirmJob.ts:29-42`; endpoint `apps/api/src/features/enrichment/routes.ts:82-126` |
| T5 | `running → completed` (empty job) | Drive finds zero rows to chunk | Unguarded | `packages/core/src/enrichment/bulk/runBulkEnrich.ts:98-104` |
| T6 | `running → completed` (last chunk) | Final chunk completes; re-reads status | **Soft-guarded** (only advances `running → completed`) | `packages/core/src/enrichment/bulk/bulkProcessEnrichChunk.ts:217-226` |
| T7 | `running → paused` | A spend brake (per-run cap / daily breaker) trips | Unguarded | `packages/core/src/enrichment/bulk/bulkProcessEnrichChunk.ts:206-210` |
| — | *(generic escape hatch)* `updateJobStatus` | Writes whatever patch it is given | **Unguarded** | `packages/db/src/repositories/enrichmentJobRepository.ts:284-288` |

Note T3 and T4 are the **only** status-pinned (guarded) transitions. As the repo comment says: "There
is NO path from queued/estimating straight to running: no bulk run can ever start (and therefore
spend) without a human first confirming the persisted worst-case ceiling."
(`packages/db/src/repositories/enrichmentJobRepository.ts:316-321`). This is the spend-safety
invariant, and it is what makes `queued` a genuine dead end rather than a transient waypoint.

---

## 4. Producer / consumer wiring (why `queued` never gets picked up)

The dashboard counts a control table; whether anything *acts* on a row depends on wiring that is
deliberately incomplete at rest.

- **Initial submit does a DB insert and nothing else.** `POST /contacts/bulk/enrich`
  (`apps/api/src/features/contacts-bulk/routes.ts:166-177`) calls `bulkEnrich`, which inserts one
  `enrichment_jobs` row and returns `{ affected, jobId }` — **no BullMQ interaction whatsoever**
  (`packages/core/src/prospect/bulkActions.ts:337-364`).
- **The BullMQ producer is the confirm endpoint, and only it.** `enqueueBulkEnrichmentDrive`
  (`apps/api/src/features/enrichment/bulkEnrichQueue.ts:45-51`) is called from exactly one place: the
  confirm HTTP handler (`apps/api/src/features/enrichment/routes.ts:119-123`). It self-gates:
  `if (!env.BULK_ENRICHMENT_ENABLED) return null` (`apps/api/src/features/enrichment/bulkEnrichQueue.ts:48`).
- **The consumer is not even constructed while the flag is off.** The `bulk-enrichment` worker is
  registered conditionally behind `env.BULK_ENRICHMENT_ENABLED` (`apps/workers/src/register.ts:636`).
  When off, `makeProcessBulkEnrichment` is never wired — there is no process reading these rows.
- **Nothing reads `queued` anyway.** Even when the worker *is* built, it consumes BullMQ `drive`/
  `chunk` messages; it never scans the DB for `queued` control rows. `queued` has no reader by design.

**Consequence:** a `queued` control row has (a) no BullMQ job pointing at it and (b) no consumer that
would ever look for it. It is inert by construction, independent of worker health.

The confirm endpoint's **dual gate + role gate** is what keeps `awaiting_confirmation` from
self-advancing:

| Layer | Check | Citation |
|---|---|---|
| Role | `requireRole("owner","admin")` | `apps/api/src/features/enrichment/routes.ts:82` |
| Global kill-switch | `if (!env.BULK_ENRICHMENT_ENABLED) throw ForbiddenError` | `apps/api/src/features/enrichment/routes.ts:85-87` |
| Per-tenant flag | `isFlagEnabledForTenant(..., BULK_ENRICHMENT_FLAG_KEY)` | `apps/api/src/features/enrichment/routes.ts:95-100` |

---

## 5. Dead and trap states: `queued`, `paused`, `failed`, `cancelled`

### 5.1 `queued` — dead end by design

There is **no `queued → *` transition anywhere in the code**. The flag-ON lane skips `queued`
entirely (T2 goes straight to `estimating`), and the flag-OFF lane lands in `queued` precisely so the
job is a no-op. This is intentional (`packages/core/src/prospect/bulkActions.ts:330-332`). A `queued`
row is not "waiting for a worker"; it is a durable record of a click that, by policy, spends nothing.

### 5.2 `paused` — a genuine trap state

`paused` is written when a spend brake trips mid-run (T7,
`packages/core/src/enrichment/bulk/bulkProcessEnrichChunk.ts:206-210`). Sibling chunks then observe
`status != running` and wind down. **But there is no resume path.** The only re-entry point,
`runBulkEnrich`, guards on `status === "running"` and returns `skipped` for anything else
(`packages/core/src/enrichment/bulk/runBulkEnrich.ts:71`). Nothing in production flips
`paused → running`.

- **Register:** as-built, `paused` is a one-way sink for any braked bulk-enrich run.
- **By-design vs defect:** this is a **latent defect**, not safe-by-default darkness — but it is only
  reachable *after* the feature is enabled and a run is confirmed and then brakes. At the current
  flag-off default it is unreachable, which is why it is not one of the 5 reported rows. It becomes a
  live incident the moment bulk-enrichment is switched on. Tracked in
  [04-issue-resolution-plan.md](04-issue-resolution-plan.md) and
  [09-reliability-fault-tolerance.md](09-reliability-fault-tolerance.md).

### 5.3 `failed` / `cancelled` — dead states (declared, never written)

Both values exist in the DB CHECK (`packages/db/src/schema/enrichmentJobs.ts:73-76`), the Zod enum
(`packages/types/src/bulkEnrichment.ts:71-81`), and the UI (`failed → danger`,
`apps/web/src/features/enrichment-jobs/components/format.ts:65-74`) — but **no production code writes
either value to an `enrichment_jobs` row**. There is no fail path and no cancel path wired for
enrichment jobs. **VERIFIED** (reconciled with 14-re-audit-and-risks.md, I-05): a repo-wide grep
confirms zero production writers of `failed`/`cancelled` to `enrichment_jobs`. The only production
`updateJobStatus` writers in the enrichment pipeline set benign states —
`packages/core/src/enrichment/bulk/runBulkEnrich.ts:99` (→ `completed` on an empty job),
`packages/core/src/enrichment/bulk/bulkProcessEnrichChunk.ts:208` (→ `paused` when a brake trips), and
`bulkProcessEnrichChunk.ts:221` (→ `completed` on the last chunk). `failed`/`cancelled` appear only in
the read-only classification helper `packages/core/src/enrichment/jobStatus.ts:34` (a
`TERMINAL_STATUSES` set used by `toEnrichmentJobSummary`) and in tests
(`packages/core/src/enrichment/jobStatus.test.ts:59,83-89`). The bulk-enrichment DLQ handler
`apps/workers/src/queues/bulkEnrichment.ts` records only a PII-free dead-letter and does **not** set
the job row to `failed` (the word "failed" there is a comment at `:117`); `apps/api/src/features/enrichment`
writes neither status. The enum values are therefore genuinely **dead** (no writer): a braked run parks
in `paused` (a trap state, no resume path), and a crashed chunk stays `running` (BullMQ retries the job
but the DB row is never marked failed).

- **Register:** as-built, an enrichment job can never reach `failed` or `cancelled`. A run that dies
  (e.g. lost enqueue, see [§6](#6-the-non-atomic-enqueue-gap-how-a-running-job-can-have-no-work))
  stays `running` forever rather than transitioning to `failed`.
- **Consequence:** the dashboard's `deadLetter = jobsByStatus.failed ?? 0`
  (`apps/api/src/features/admin/dataRoutes.ts:182`) will read **0 by construction**, giving a false
  sense of "no failures" even when runs have silently wedged. This is a genuine observability gap, not
  by-design darkness.

---

## 6. The non-atomic enqueue gap (how a `running` job can have no work)

The DB rows are created with **zero BullMQ interaction** (`packages/core/src/prospect/bulkActions.ts:337-364`).
The single enqueue happens **later and outside any shared transaction**, in the confirm HTTP handler:
the guarded `awaiting_confirmation → running` write commits first
(`apps/api/src/features/enrichment/routes.ts:101`), then `enqueueBulkEnrichmentDrive` runs
(`apps/api/src/features/enrichment/routes.ts:119`). These are two independent operations with no
outbox and no compensating action between them.

Two ways this drops work:

1. **Process dies between confirm and enqueue.** The job is now `running` in the DB, but no `drive`
   job ever reached Redis.
2. **Producer returns `null`.** If the flag were flipped off between arming and confirm (or the
   producer's self-gate `bulkEnrichQueue.ts:48` fires), the enqueue is a silent no-op — again a
   `running` job with no `drive` in Redis.

Because `runBulkEnrich` is **resumable only if a drive job lands** (it re-enqueues unfinished chunks
on re-drive, `packages/core/src/enrichment/bulk/runBulkEnrich.ts:82-92`), a lost enqueue is **not
self-healing**. The result is a permanently stuck `running` job — and since `failed` is never written
([§5.3](#53-failed--cancelled--dead-states-declared-never-written)), it never surfaces as a failure.

- **Register:** this is **at-least-once with a gap**, not a transactional guarantee. ADR-0027
  explicitly rejects the enqueue-after-commit pattern this code uses in favour of a transactional
  outbox ("DB commit ⇒ event published", crash-safe) — see
  `docs/planning/decisions/ADR-0027-real-time-delivery-and-event-backbone.md`. So this is a **known
  gap against sanctioned design**, addressed in
  [09-reliability-fault-tolerance.md](09-reliability-fault-tolerance.md).
- **Why it is not one of the 5 reported rows:** it manifests as stuck **`running`**, not `queued` or
  `awaiting_confirmation`. It is only reachable once the feature is enabled and a human confirms. It
  belongs on the live-inspection checklist ([03-live-inspection-runbook.md](03-live-inspection-runbook.md)).

---

## 7. Tracing each of the 5 stuck rows

The dashboard reports `Queued: 4, Awaiting Confirmation: 1`. `awaiting_confirmation` is **deliberately
excluded** from the `queueDepth` tile because it is blocked on a human, not on a worker
(`apps/api/src/features/admin/dataRoutes.ts:166-167`; tiles at
`apps/admin/src/features/system-health/components/SystemHealthPage.tsx:192-199`, queue-depth tile
`:143-147`). Data path: `enrichmentJobStatusCounts`
(`packages/db/src/repositories/platformAdminReads.ts:549-554`) → `dataRoutes.ts:160-183` → the tiles.

### 7.1 The four `queued` rows

**How each was created:** a user (any active role) called `POST /contacts/bulk/enrich`
(`apps/api/src/features/contacts-bulk/routes.ts:166-177`) → `bulkEnrich`
(`packages/core/src/prospect/bulkActions.ts:337-364`). Because `env.BULK_ENRICHMENT_ENABLED` is off
(default), the branch `status: enabled ? "estimating" : "queued"` chose `queued`
(`packages/core/src/prospect/bulkActions.ts:354`) and inserted the row (`:347-357`). No estimate was
computed, no BullMQ job was enqueued, no credits were touched. Four such clicks → four rows.

**Why it will not advance (in priority order — this is the ranked list):**

| Rank | Cause | Register | Citation |
|---|---|---|---|
| 1 | `BULK_ENRICHMENT_ENABLED` off (default) → **inert orphan by design** | By-design | `packages/core/src/prospect/bulkActions.ts:330-332,354` |
| 2 | **No `queued → *` transition exists at all**; the flag-ON lane skips `queued` | By-design (structural) | `packages/core/src/prospect/bulkActions.ts:354` (T2 → `estimating`); no writer in table §3.3 |
| 3 | Worker health is **irrelevant** to `queued` — the consumer is only built when the flag is on, and it never reads `queued` rows regardless | By-design | `apps/workers/src/register.ts:636` |

**Verdict:** all four `queued` rows are **by-design inert orphans.** No worker action, no
configuration change, and no incident is implied. They are the expected artefact of a
feature-flagged-off money path.

### 7.2 The one `awaiting_confirmation` row

**How it was created:** this row's submission happened while `env.BULK_ENRICHMENT_ENABLED` was **on**.
`bulkEnrich` chose `estimating` (`packages/core/src/prospect/bulkActions.ts:354`), then immediately
persisted the worst-case ceiling and armed the gate via `setEstimateAwaitingConfirmation`
(`packages/core/src/prospect/bulkActions.ts:358-362` →
`packages/db/src/repositories/enrichmentJobRepository.ts:331-345`), moving it `estimating →
awaiting_confirmation`. `[ASSUMPTION]` The single `awaiting_confirmation` row implies the flag was on
at least at that job's submit time (possibly on a prior deploy or in a specific tenant); if the global
switch currently reads off, this row is now unconfirmable (rank 2 below). Confirm on the live env per
[03-live-inspection-runbook.md](03-live-inspection-runbook.md).

**Why it will not advance (ranked):**

| Rank | Cause | Register | Citation |
|---|---|---|---|
| 1 | **No human clicked confirm.** This is the intended resting state — a job waits here indefinitely for an owner/admin to accept the ceiling. | By-design | `apps/api/src/features/enrichment/routes.ts:82-126` (the only advance door) |
| 2 | Confirm endpoint **403s** because the global switch is now off (`routes.ts:85-87`) or the tenant is not enrolled (`routes.ts:95-100`) → **armed-but-unconfirmable** | By-design (safe) / operational | `apps/api/src/features/enrichment/routes.ts:85-87,95-100` |
| 3 | **Role starvation** — a member/viewer can GET the job but cannot confirm; only owner/admin may | By-design | `apps/api/src/features/enrichment/routes.ts:82` |
| 4 | **Armed-then-flag-flipped-off** — the gate was armed while on, the flag was later turned off → permanently stuck (a special, permanent case of #2) | Latent edge / operational | `apps/api/src/features/enrichment/routes.ts:85-87` |

**Verdict:** the single `awaiting_confirmation` row is **by-design** — a job correctly parked at the
human confirm gate. It is *not* evidence of a broken worker. The only action it may warrant is a
deliberate operator decision to confirm or cancel it (runbook in
[13-operational-runbooks.md](13-operational-runbooks.md)).

---

## 8. Genuine failure modes to rule out (NOT the reported symptom)

The five reported rows are explained by design. But a **healthy dashboard tally does not prove a
healthy worker**, because the failure modes below either (a) present as a *different* stuck state or
(b) would be invisible in these particular counts. Each must be checked on the live environment — the
exact commands and an interpretation matrix are in
[03-live-inspection-runbook.md](03-live-inspection-runbook.md).

| # | Failure mode | Symptom it actually produces | Why the 5-row tally won't reveal it | Citation |
|---|---|---|---|---|
| A | **Worker never booted** (or flag off, so the consumer was never constructed) | No `bulk-enrichment` consumer exists | With the flag off this is *expected*; `queued` rows are inert regardless | `apps/workers/src/register.ts:636` |
| B | **Redis wedged at runtime** (`maxRetriesPerRequest:null` → ioredis buffers commands forever, no error) | Confirmed jobs sit in **`running`** with un-drained BullMQ; `/health` still returns 200 | Affects `running`, not `queued`/`awaiting_confirmation`; health probe never checks Redis | `apps/workers/src/register.ts:132`; `apps/workers/src/health.ts:15-20` |
| C | **Boot crash from an unrelated missing env var** (whole-app schema; worker dies if `AUTH_ORIGIN`, `DATABASE_URL`, `BLIND_INDEX_KEY`, etc. are missing) | Worker process not running at all | Nothing advances *any* state, but the tally looks identical to a healthy flag-off system | `packages/config/src/env.ts:328-335,352` |
| D | **Lost drive enqueue** after confirm (non-atomic gap, [§6](#6-the-non-atomic-enqueue-gap-how-a-running-job-can-have-no-work)) | A **`running`** job with no `drive` job in Redis; never self-heals; never becomes `failed` | Manifests as stuck `running`, and `failed` is never written | `apps/api/src/features/enrichment/routes.ts:101,119`; `packages/core/src/enrichment/bulk/runBulkEnrich.ts:82-92` |
| E | **Braked run parked in `paused`** with no resume path | A stuck **`paused`** job | Only reachable post-enable; `paused` is a trap ([§5.2](#52-paused--a-genuine-trap-state)) | `packages/core/src/enrichment/bulk/runBulkEnrich.ts:71`; `bulkProcessEnrichChunk.ts:206-210` |

**Fast triage heuristic.** If the *only* non-terminal states present are `queued` and one
`awaiting_confirmation`, and there are **zero `running`/`paused`** rows, the system is behaving exactly
as a correctly flagged-off (or awaiting-human) deployment should. If you see stuck **`running`** or
**`paused`** rows, escalate to modes B/D/E and run the live runbook.

---

## 9. By-design vs genuine-defect summary

| Observation | Register | Action |
|---|---|---|
| `Queued: 4` | **By-design** (inert orphan, flag off) | None. Expected. |
| `Awaiting Confirmation: 1` | **By-design** (parked at human gate) | Optional operator confirm/cancel decision only. |
| `queued` has no outgoing transition | **By-design** (structural) | None — intended dead end. |
| `paused` has no resume path | **Genuine defect** (latent; reachable only post-enable) | Wire a resume/cancel path before enabling. See [04](04-issue-resolution-plan.md), [09](09-reliability-fault-tolerance.md). |
| `failed`/`cancelled` never written | **Genuine gap** (no fail/cancel wiring; `deadLetter` reads 0 falsely) | Wire terminal-failure transitions + surface them. See [04](04-issue-resolution-plan.md), [10-observability-alerting.md](10-observability-alerting.md). |
| Non-atomic confirm→enqueue | **Genuine gap vs ADR-0027** (no outbox; lost enqueue → stuck `running`) | Adopt transactional outbox. See [09](09-reliability-fault-tolerance.md). |
| Worker down / Redis wedged / boot crash | **Genuine failure modes to rule out** | Run [03-live-inspection-runbook.md](03-live-inspection-runbook.md). |

---

## 10. Recommendations (not yet built — clearly marked as proposals)

These are **recommendations**, not descriptions of existing behaviour. Detailed fix/rollback/validation
plans belong in [04-issue-resolution-plan.md](04-issue-resolution-plan.md) and
[15-phased-implementation-plan.md](15-phased-implementation-plan.md).

1. **Confirm-on-live before any code change.** Run [03](03-live-inspection-runbook.md) to positively
   establish "by-design" vs "faulted." Do not treat the tally as an incident until modes B/D/E are
   excluded. *(Recommendation — Phase 0.)*
2. **Close the `paused` trap.** Add an explicit, guarded `paused → running` resume (and/or `paused →
   cancelled`) path so a braked run can be resumed or terminated. Must land **before**
   `BULK_ENRICHMENT_ENABLED` is switched on for any tenant. *(Recommendation.)*
3. **Wire terminal failure.** Give enrichment jobs a real `failed`/`cancelled` writer so a wedged run
   surfaces, and so `deadLetter` (`apps/api/src/features/admin/dataRoutes.ts:182`) stops reading a
   structural 0. *(Recommendation.)*
4. **Make confirm→enqueue crash-safe.** Replace enqueue-after-commit with the transactional outbox
   ADR-0027 mandates, eliminating the lost-drive-enqueue stuck-`running` class entirely.
   *(Recommendation — see [09](09-reliability-fault-tolerance.md).)*
5. **Surface `awaiting_confirmation` and stuck-state age** in the dashboard/alerting so an operator can
   see *how long* a job has waited on a human vs. a worker. *(Recommendation — see
   [10-observability-alerting.md](10-observability-alerting.md).)*

---

*Next: [03-live-inspection-runbook.md](03-live-inspection-runbook.md) turns §8 into exact live commands
and an interpretation matrix. For the fix backlog see
[04-issue-resolution-plan.md](04-issue-resolution-plan.md).*
