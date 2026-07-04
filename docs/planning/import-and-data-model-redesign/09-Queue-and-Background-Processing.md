# 09 — Queue & Background Processing

> **Status of this doc:** complete (design doc — target state 🔲 not built; nothing ships from
> this series). Evidence cites [`01-Current-State-Audit.md`](01-Current-State-Audit.md); gaps cite
> [`02-Root-Cause-and-Gap-Analysis.md`](02-Root-Cause-and-Gap-Analysis.md); every external-platform
> claim cites the register in [`03-Enterprise-Research.md`](03-Enterprise-Research.md).
> **Owns:** **G06** (imports bypass the shipped transactional outbox — P1) and the **backend half
> of G11** (durable progress so polling never dies; doc `11` owns the frontend half). Owns *how*
> doc [`08`](08-Import-Architecture.md)'s state machine **executes**: queue topology, tenant
> fairness, retry/DLQ policy, the progress contract, cancellation mechanics, and outbox-driven
> notifications. It does **not** re-spec the state machine, the verbs, or the API surface — those
> are 08's; nor the owner-visibility predicate (doc `10`), the published limit numbers (doc `12`),
> or artifact PII posture (doc `13`).
> **Step IDs:** `S-Q1`…`S-Q8` (sequenced in doc `15`; never fixed migration numbers).

---

## Objective

Make the unified import job model (08 §1) *executable and unlosable*. One queue carries all
import work with a priority lane for small files; one tenant's 2M-row import cannot starve
another's 200-row file; every job kind has an explicit retry/DLQ budget; progress is durable
DB counters a client can poll forever; cancellation is cooperative and honest; and every
user-facing lifecycle event travels through the shipped transactional outbox in the same
transaction as the state change — so the failure the market never forgives (**losing** the
job, not slowness — 03 §6.1 [138][142]) becomes structurally impossible.

---

## Reconciliation (what this design extends and must never contradict)

Pinned before any design claim, per the series convention.

**Worker-platform decisions (aligned with, never re-derived).** The
[`worker-platform/`](../worker-platform/README.md) series is the queue substrate's
design-of-record; its buildable phases 0–5 are implemented on this branch pending CI
(`worker-platform/15-phased-implementation-plan.md` header):

1. **"Queued 4 / Awaiting Confirmation 1" is by design** — a DB census of `enrichment_jobs`
   rows, not BullMQ depth, produced by the deliberately dark bulk-enrich path
   (`worker-platform/00-executive-summary.md` §1–2). §9 exists so the import redesign never
   reproduces that support-confusing ambiguity.
2. **The transactional outbox is shipped and leaderless** (ADR-0027): `worker_outbox` intents
   written in the same tenant tx, drained `FOR UPDATE SKIP LOCKED` by
   `apps/workers/src/outboxRelay.ts` (poll 1 s, batch 25, unknown-topic = terminal fail —
   `outboxRelay.ts:33–36,49–53`), at-least-once, consumers dedupe by stable jobId
   (`workerOutbox.ts:5–7`). A second outbox, `event_outbox`, feeds the realtime SSE backbone
   via `realtimeRelay.ts` (leaderless, dark behind `REALTIME_SSE_ENABLED` —
   `realtimeRelay.ts:3–7,14–15`). **Neither import path uses either today** (01 §7.1, L20) —
   G06. This doc makes imports the outbox's first consumer beyond the bulk-enrich confirm.
3. **Retry/tuning/deadline conventions are fixed:** exponential backoff **with jitter 0.5**
   everywhere (`retryPolicies.ts:13–14`); event-worker lock discipline 60 s lock / 30 s
   stalled check / 2 stalls → DLQ (`tuning.ts:24–28`); per-queue processor deadlines via
   `withDeadline` (imports currently 15 min, `tuning.ts:61–71`); fail-loud tuning lookup
   (`tuning.ts:78–88`). New queue work *extends these tables*, never invents parallel policy.
4. **Concurrency raises are gated.** `imports` is pinned at 1 with a documented rationale
   (`tuning.ts:31,39`); the spend path is pinned serial behind the F3 atomic-breaker gate
   (`tuning.ts:6–10`). Imports are **not** a spend path, so F3 does not bind them — but any
   raise still lands through `tuning.ts` + its tripwire test, CI-verified.
5. **Priority and fairness have a sanctioned shape:** priority tiers with pool placement +
   BullMQ job `priority` *within* a tier; both import lanes sit in **T1 bulk/ingest**
   (`worker-platform/07-target-architecture.md` §3); fair-share dispatch is weighted
   round-robin **with aging** (re-audit F7, 07 §6.2) — a Phase-5-scale mechanism this doc
   must not casually pre-build (§2 picks the interim mechanism accordingly).
6. **Observability conventions:** the zero-dep Prometheus `/metrics` increment is shipped
   (counters + depths + `outboxOldestPendingSeconds`, `metrics.ts:1–7,55–56`); the target
   catalog names (`queue.oldest_waiting_age` as "the linchpin"; per-bulk-job accounting where
   an unreconciled total is itself alertable) are `worker-platform/10-observability-alerting.md`
   §4. §8 adopts those names.

**The import design-of-record:
[`../data-management/15-bulk-import-design.md`](../data-management/15-bulk-import-design.md) §2**
fixes the pipeline this doc schedules: the API enqueues **only** `{kind:'drive', jobId,
scope}` (never rows); drive stages + fans out ~10k-row bands; chunk merges one band in one
`withTenantTx` writing the `import_job_rows` ledger + **atomic counter deltas**; the **last**
chunk finalizes exactly once (atomic `completed_chunks == total_chunks`); idempotency is
3-level (job `idempotency_key` · `(job_id, chunk_index)` + terminal-skip resume watermark ·
row `content_hash`); accounting is the 7-bucket identity. Nothing below alters that pipeline
— this doc governs its transport, ordering, recovery, and eventing.

**Surface-1 counterpart:
[`../database-management-research/05-Upload-Pipeline-Design.md`](../database-management-research/05-Upload-Pipeline-Design.md)**
owns the **completer/reaper pattern and the chunk-lease columns** (its §5.4 + ownership
note), the operator verbs, and E5 (worker crash mid-`running`: object store is truth, reaper
re-enqueues lease-expired chunks). §7 composes that reaper as the DB-backed recovery spine;
the columns and the `bulk-import-reaper-sweep` registration are that doc's steps, consumed
here, not duplicated.

**Doc 08 is consumed as a contract:** the state machine incl. `draft/uploading/deferred`
(08 §2), fast/copy routing at commit (08 §1), cancel *semantics* (08 §2.2), the verb table
(08 §2.3), and the Phase A/B/C compatibility window (08 §1.2). This doc supplies the
mechanics those sections forward-reference.

**Shipped code this builds on (verified at head):** producers `queue.ts` (attempts 3, exp
2 s + jitter 0.5, terminal retention 24 h/1000, `queue.ts:28–32`; 10k shed, `queue.ts:41,48`)
and `bulkQueue.ts` (same policy; 1k drive shed, `bulkQueue.ts:45`); the fail-open typed-503
shed with `retryAfterSeconds` (`queueBackpressure.ts:34,38–45`); consumers `imports.ts`
(zero-progress ⇒ `ImportFailedError` ⇒ retry ⇒ DLQ, `imports.ts:63–66`; PII-free dead-letter,
`imports.ts:75–95`) and `bulkImports.ts` (finalize only on real completion; rollups once,
`bulkImports.ts:100–112`; PII-free DLQ, `bulkImports.ts:131–154`); composition `register.ts`
(instrument + `withDeadline` + tuning, `register.ts:584–593`; best-effort completed-handler
rollups **and** `import_complete` notification, `register.ts:600–645`; dark bulk construction,
`register.ts:848–898`).

**Contradiction scan.** (a) `bulkImports.ts`'s header says the rollups hook is "best-effort …
must never fail the chunk job" — correct *as transport discipline*, but as an eventing model it
is exactly what ADR-0027 rejects; §6 supersedes the best-effort posture **for user-facing
events and rollups** while keeping the never-fail-the-chunk rule (the outbox write is in-tx,
so it cannot fail separately). (b) The `imports` queue's `removeOnComplete 24h/1000`
(`queue.ts:31`) was the G03 defect *only because the queue was the system of record*; once 08
demotes Redis to transport, aggressive queue-side retention becomes correct hygiene and is
kept. (c) No BullMQ `priority` is used anywhere today (repo-wide grep) — §1's priority lane is
new, inside the worker-platform §3 sanction.

---

## Current Challenges (headline only — the as-is is doc 01)

- Two queues, two policies, one system of record in the wrong place: sync `imports` carries
  whole row payloads with Redis-only state; dark `bulk-imports` has the durable trio (01 §2).
- Completion side-effects are all best-effort post-commit: sync rollups + the importer's
  `import_complete` notification fire from a BullMQ `completed` handler
  (`register.ts:600–645`); bulk finalize fires rollups directly (`register.ts:865–884`) and
  has **no** completion notification at all. A crash at the wrong instant silently drops a
  user-facing "your import finished" (G06).
- Polling dies by design: 1.5 s × 80 then give-up copy (01 §4.2, G11); the bulk page polls
  the DB row correctly but only for the dark path.
- No tenant fairness anywhere: one queue, FIFO, concurrency 1; a whale's fan-out would
  head-of-line block every other tenant the day the flag flips (worker-platform 07 §6.2:
  "no per-tenant fairness" is an as-built fact).
- Backpressure exists but is invisible: the 10k/1k sheds are internal 503s, not a product
  state (G12 — doc 12 publishes the numbers; 08 §2 adds the `deferred` state).

## Enterprise Best Practices (cited via 03's register only)

- **Queue-native state is ephemeral by the vendors' own account**; every serious platform
  layers a durable DB job record above the queue (03 §6.1 [138][142]).
- **Progress = durable counters on the job resource, polled indefinitely**; webhooks/push are
  an optimization with polling as the documented safety net; no public import API ships SSE
  (03 §6.1 [56][54][129][130][18]).
- **10,000-row internal chunking with bounded per-chunk retry, then the job fails** — the
  Salesforce envelope this pipeline already mirrors (03 §6.1 [63][77]).
- **Cancel = stop-remainder, never rollback**; remainder reported as unprocessed, distinct
  from failed (03 §6.1 [61][60]). BullMQ has **no first-class cancel of an active job** —
  cooperative flag checks are the documented pattern (03 §6.1 [140][141]).
- **Visible backpressure beats silent queueing** (HubSpot's `DEFERRED` state, 03 §6.1 [18]);
  **`addBulk` degrades above ~1k jobs/call** (03 §6.1 [139]) — one more reason §2's rolling
  fan-out beats enqueue-everything-up-front.

## Gaps (register pointers — evidence in 01, linkage in 02)

| Gap | Sev | This doc's answer |
|---|---|---|
| **G06** | P1 | §6: lifecycle events + rollups + notifications ride the shipped outboxes, written in the same tx as the transition; imports become the outbox's first real consumer |
| **G11** (backend half) | P1 | §4: DB-truth counters + a poll endpoint that never dies; SSE event names reserved as additive transport; doc 11 owns the UI half |
| G03/G05 | P0/P1 | consumed from 08 (durable row; cancel verb) — §5 supplies the cooperative mechanics |
| G12 | P2 | §1.3 restates the sheds as product limits; the numbers are doc 12's |
| G25 | P2 | ledger growth/partitioning — doc 12; §4.2 bounds the write cadence it must absorb |
| G01 | P0 | forward-ref: nothing in this doc reads job rows without doc 10's viewer context |

---

## Recommended Solution

### §1 Queue topology — one import queue, priority lanes, legacy retirement 🔲

#### §1.1 The call: `bulk-imports` becomes THE import execution queue

The unified job model (08 §1) gets **one** BullMQ queue: the shipped `bulk-imports` queue,
carrying its existing discriminated job kinds — `drive` and `chunk` (`bulkImports.ts:76–99`) —
for **both processing modes**. A fast-mode import is a `drive` that skips staging and fans out
exactly one chunk (08 §1: one real `import_job_chunks` row), so the consumer code path is
*already* uniform; only the transport was split. The legacy `imports` queue (rows-in-payload)
survives the compatibility window as-is and then retires (§1.4).

**Fast path = priority lane on the same queue, via BullMQ job `priority` — not a separate
queue.** Justification against the alternative:

- **The worker-platform tier model already decides this.** Priority *within* a tier is
  expressed by BullMQ `priority`; separate pools are the *cross-tier* mechanism (T0 money vs
  T1 bulk) — and both import lanes are T1 (`worker-platform/07` §3). A second import queue
  would be another intra-T1 pool with its own tuning row, census tile, DLQ, and alert set,
  for no isolation benefit.
- **One queue = one fairness computation** — §2's caps are enforced at the single fan-out
  point — **and one self-balancing consumer pool**: a split fast/bulk pool idles one side
  while the other backs up; a priority-ordered queue keeps every worker busy and still
  serves fast jobs first from the waiting set.
- **Cost is negligible at our depths:** prioritized insertion is O(log n) over the waiting
  set, and the drive shed caps waiting at 1 000 (`bulkQueue.ts:45`).

**Priority bands** (BullMQ: lower number = served first): fast drive/chunk = 1 · copy drive =
5 · copy chunk = 10 · retry-child jobs inherit their mode's band. Within a band, FIFO.

**The honest limitation, stated:** priority orders the *waiting* set only — there is no
preemption of an active chunk (03 §6.1 [140]). With chunk concurrency C, a fast job's worst
case is waiting for one in-flight chunk per busy slot ≈ **one chunk duration** (a ~10k-row
band; envelope numbers in doc 12). While the dark-era tuning holds concurrency at 1
(01 §2.2 hop 6), that is the whole worst case; the concurrency raise is a `tuning.ts` change
gated on CI (Reconciliation #4). **Escape hatch:** if doc 12's fast-lane p95 wait SLO is
breached under sustained mixed load, split a `imports-fast` queue *within T1* — a queue-name +
tuning-entry change, not an architecture change; the job kinds and processor are already
shared. Recorded as the §8 alert's runbook action, not pre-built.

#### §1.2 Job kinds and their transport contract

| Kind | Producer | Payload (PII-free, always) | Stable jobId (consumer dedupe) |
|---|---|---|---|
| `drive` | API commit (via outbox, §6.4) · scheduler promoting `deferred` · reaper re-drive | `{kind:'drive', jobId, scope}` | `import-drive:<jobId>` |
| `chunk` | drive fan-out · rolling-window continuation (§2.2) · reaper re-enqueue | `{kind:'chunk', jobId, chunkId, scope}` | `import-chunk:<chunkId>` |
| `notify` (new topic, not a queue job — §6.3) | terminal tx via `worker_outbox` | `{jobId, scope, terminalStatus}` | `import-notify:<jobId>:<status>` |

Rows never travel in payloads on this queue (the design-of-record's rule, data-management/15
§2). The legacy queue's rows-in-payload transport is precisely what retires. Stable jobIds
make every re-publish (outbox at-least-once, reaper, double-drive) a BullMQ-level dedupe or a
consumer-level idempotent replay — never a second effect.

#### §1.3 Backpressure: internal sheds stay, product limits go visible

The shipped fail-open sheds stay as the *infrastructure* fuse: 10k waiting on the legacy queue
(`queue.ts:41`), 1k waiting drives on the unified queue (`bulkQueue.ts:45`), typed 503 +
`retryAfterSeconds` (`queueBackpressure.ts:38–45`). Above them sits the *product* layer from
08 §2: the per-workspace concurrency cap surfaces as the **`deferred` state** (visible
backpressure, 03 §6.1 [18]) and the per-workspace commit quota 429s honestly. Doc 12 owns all
three published numbers (per-file rows/bytes · daily quota · concurrency cap); this doc's rule
is only: **a user must never meet the raw 503 before the product limit** — the caps are sized
so `deferred` and the quota engage first, and the 503 remains the never-in-normal-operation
fuse whose firing is an §8 alert, not a UX.

#### §1.4 Legacy `imports` queue retirement (cross-ref doc 15 for sequencing)

Phase A (08 §1.2) keeps the legacy queue as-is — the fast wrapper wraps its consumer. At
Phase B cutover the API stops producing to it; the consumer stays registered one release to
drain stragglers (`IMPORTS_DLQ` kept until empty + one retention window, then archived); then
the registration, tuning/deadline rows, and producer module are deleted. Rollback during the
window = flip the producer switch back — both consumers are live and idempotent, so a
mid-drain flip loses nothing. `BULK_IMPORTS_DLQ` and its PII-free record shape carry over to
the unified queue unchanged.

### §2 Tenant fairness — bounded rolling fan-out + per-workspace caps 🔲

#### §2.1 The mechanism chosen, and why

**Chosen: (a) a per-job chunk window K (bounded rolling fan-out) + (b) the per-workspace
job-concurrency cap (08's `deferred` state), with (c) fast-lane priority from §1.** Rejected
for now: **weighted round-robin drive scheduling** — a custom fair dispatcher is exactly the
worker-platform Phase-5 fair-share mechanism (weighted RR **with aging**, re-audit F7, 07
§6.2), which is sequenced *after* the observability stack that would tune it and is designed
at pool scale. Building a bespoke interim scheduler here would be a second implementation of
a decided-but-not-yet-due mechanism; the window/cap pair delivers the product guarantee with
zero new infrastructure and composes cleanly under the Phase-5 dispatcher when it lands.

#### §2.2 Mechanics

- **Chunk window K (default 2, config knob):** the drive enqueues only the first
  `min(K, total_chunks)` chunk jobs instead of all bands (also dodging `addBulk` degradation
  above ~1k jobs, 03 §6.1 [139] — a 2M-row import is ~200 bands). Each chunk processor, after
  its merge tx commits (and the `finalizeIfLastChunk` check, `bulkImports.ts:100–112`),
  enqueues the lowest-indexed still-`pending` chunk for its job — a self-perpetuating window.
  Crash safety: a lost continuation enqueue is healed by the reaper (§7 row 2) from the chunk
  rows — DB is truth, the window is reconstructable.
- **Per-workspace job cap:** at most N jobs of a workspace in `validating|staged|running`
  (N is doc 12's published number); the commit verb parks overflow in `deferred` (08 §2.1);
  promotion `deferred → queued` is a **leader-locked scheduler sweep** (the house sweep
  idiom, serial-by-design — `tuning.ts:50–52`), oldest-first per workspace — pairs with 08's
  S-I10.
- **Interaction:** the window caps *intra-job* parallelism; the job cap bounds per-workspace
  fan-out to K × N in-flight chunks; §1's priority puts other tenants' fast work ahead of a
  whale's waiting chunks.

#### §2.3 The worst case, stated

Whale tenant commits a 2M-row copy import (~200 chunks): only K(=2) of its chunks are ever
waiting/active. Another tenant's fast import enqueues at priority 1, jumping all waiting
copy chunks; its wait is bounded by **in-flight** work only — ≤ one ~10k-row chunk duration
per busy worker slot (§1.1); at today's dark-era concurrency 1 that is the whole worst case.
The whale is not starved either: its window refills on every completion. What this mechanism
deliberately does **not** guarantee: proportional fair *share* between two simultaneous
whales — they interleave at window granularity, acceptable at N-jobs-per-workspace scale and
exactly the residual the Phase-5 weighted-RR-with-aging dispatcher exists to close (F7).

### §3 Retry & DLQ policy per job kind 🔲

House posture (Reconciliation #3): exponential + jitter 0.5 always; PII-free dead-letter
records always (`imports.ts:75–95`, `bulkImports.ts:131–154`); DLQ per queue preserved.
Per-kind budgets — the column that matters is *what a replay can and cannot do*:

| Job kind | Attempts | Backoff base | Deadline (`withDeadline`) | Replay-safe because | Must-not-double-fire, handled by |
|---|---|---|---|---|---|
| `drive` (fast + copy) | 3 (shipped, `bulkQueue.ts:33`) | 2 s | 15 min (copy; stage-bound) · 2 min (fast) | watermark resume — a re-drive never re-stages (data-management/15 §2; `runBulkImport` resume, 01 §2.2 hop 7); chunk fan-out dedupes on stable jobId + `(job_id, chunk_index)` unique | — |
| `chunk` | 3 | 2 s | 10 min | **row ledger + 3-level idempotency**: terminal-skip on the chunk row, row `content_hash`, dedup-key upserts — re-merging a band promotes nothing twice (data-management/15 §2) | counter deltas: applied once per chunk *completion tx*, not per attempt (the delta write commits with the merge, so a failed attempt contributes nothing) |
| finalize (in-chunk step, not a job) | rides its chunk's budget | — | — | — | **the atomic completer**: only a real completion increments `completed_chunks`, and only the transition `completed_chunks == total_chunks` finalizes — exactly once by construction (`bulkImports.ts:100–112`, shipped) |
| error-report/artifact write (finalize step) | 3 internal retries then job stays terminal with `artifact_pending` flag re-swept by the reaper | 5 s | — | artifact write is idempotent (same key, full overwrite); the terminal status never blocks on it | terminal transition commits *before* artifact upload — a crash re-runs only the upload |
| `notify` (outbox topic) | relay attempts cap (`workerOutbox.ts:28–30`) then row `failed` + alert | relay poll cadence | — | consumer dedupes on `import-notify:<jobId>:<status>` (§6.3) | idempotent insert — replay is a no-op |
| legacy `imports` (window only) | 3 (shipped, `queue.ts:28–29`) | 2 s | 15 min (`tuning.ts:62`) | zero-progress throws `ImportFailedError` so a wholly-failed run retries instead of silently completing (`imports.ts:63–66`); per-row `content_hash` makes the retry idempotent | — |

Exhaustion always dead-letters (never silent loss), and **job-level truth follows**: a chunk
that dead-letters marks its chunk row `failed`, its band's unattempted rows count into
`rows_unprocessed`, and the completer still terminalizes the job (`partial`/`failed`) — the
bounded-retry-then-job-verdict envelope (03 §6.1 [63][77]). A DLQ'd chunk is *also* re-drivable
by an operator after the cause is fixed (redrive surface = Surface 1, db-mgmt-research/05
§9.2) because replay is idempotent. Stall containment: the event-lock discipline (60/30/2)
plus deadlines means a crashed or hung worker's chunk re-enters the retry path in bounded
time rather than holding a lock forever (Reconciliation #3).

### §4 The progress contract — DB is truth, polling never dies (G11 backend) 🔲

#### §4.1 Truth and derivation

- **Truth:** the `import_jobs` row — status + the eight `rows_*` counters +
  `completed_chunks/total_chunks` (01 §2.2), maintained by **atomic counter deltas**
  (`SET x = x + $n`, the shipped repository discipline — data-management/15 §2). Never
  read-modify-write, never BullMQ `job.progress` as source (the legacy
  `updateProgress` at `imports.ts:43,58` becomes advisory during the window, then retires).
- **Derived, server-side, in the detail response (08 §7):** `percent` = rows_processed /
  rows_total (fast) or a chunk-weighted blend (copy: completed bands + current band's row
  deltas); `stage` = the 08 §2 state plus, while `running`, `"chunk i of n"`. Derivation
  lives in one shared function so poll and SSE can never disagree.

#### §4.2 Update cadence + contention bound

One counter-delta UPDATE per **merge batch** (~500–1000 rows), committed inside the batch's
tx — a 10k chunk writes ≤ 20 single-row UPDATEs to its job row. Upper bound on job-row
writers: the chunk window K (§2.2), so lock contention on the hot row is ≤ K writers of
sub-millisecond UPDATEs — negligible against the merge work itself; doc 12 carries the
measured envelope. Fast mode: one delta per batch or per 2 s, whichever first, so a small
file still shows motion. The trade taken knowingly: progress granularity is batch-level, not
row-level — smoother displays interpolate client-side (doc 11), never by writing more.

#### §4.3 Poll semantics — the endpoint that never gives up

`GET /imports/:id` (08 §2.3) reads the durable row and **always answers** — for the life of
the row (≥90 days listable, 08 §Success), not the life of a Redis key. No attempt cap, no
give-up state anywhere in the contract: the market's durable-counter model is polled
indefinitely (03 §6.1 [56][129]). Recommended client cadence (doc 11 implements): 2–3 s while
`validating|staged|running`, 10 s while `queued|deferred`, stop on terminal — resumable from
any page load because the handle is a URL, not in-memory state (RC-3's
navigation-destroys-the-handle dies here). Server cost: one PK read, rate-limited (08 §2.3).

#### §4.4 SSE — additive transport, names reserved now, wiring deferred

The realtime backbone is already shipped and dark (`event_outbox` → `realtimeRelay` → Redis
pub/sub → authenticated SSE, `realtimeRelay.ts:3–7`). This series **reserves the event
vocabulary now** so payload shapes are stable when wiring lands (a doc 14 slice):
`import.job.state_changed` `{jobId, status, previousStatus}` ·
`import.job.progress` `{jobId, countersSnapshot, completedChunks, totalChunks}`, throttled to
≥2 s per job at the producer (one outbox row per window, never per batch — event volume stays
O(duration), not O(rows)) · terminal set `import.job.completed|partial|failed|cancelled`
`{jobId, counters, artifactAvailable}`. All payloads PII-free by the outbox contract
(`eventOutbox.ts:6,32`). **Polling remains the documented safety net** — SSE is garnish,
exactly the market posture (03 §6.1 [129][130][18]); no client behavior may *require* the
stream.

### §5 Cancellation mechanics — cooperative, at chunk boundaries 🔲

Semantics are 08 §2.2's (stop-remainder, never rollback — the Salesforce abort contract,
03 §6.1 [61][60]; committed chunks stay; UI copy says "Contacts already imported are kept").
This doc supplies the machinery:

1. **The flag is the job row.** The cancel verb transitions `status = 'cancelled'` under
   `FOR UPDATE` (08 §2.1's legality guard). No Redis signal is sent — BullMQ cannot cancel an
   active job anyway (03 §6.1 [140][141]); the queue jobs discover it cooperatively.
2. **Check points:** drive checks between stage phases; chunk checks at claim **and** per
   merge batch (~every 500–1000 rows). The in-flight batch always completes (per-batch tx
   atomicity); worst-case overshoot after cancel = one batch, bounded and documented.
3. **A cancelled-discovering worker:** stops, marks its remaining band rows `unprocessed`
   (set-based ledger insert by `row_index` range — cheap, no row data), and exits *successfully*
   (a cancel is not a failure; no retry, no DLQ).
4. **Finalize still runs for cancelled jobs.** The completer executes a terminal pass:
   unclaimed bands counted into `rows_unprocessed` (the accounting identity holds with
   `unprocessed` absorbing the remainder), **artifacts still produced** (the repair CSV
   includes unprocessed rows — 08 §6.2 — so cancel→fix→re-import-the-rest is one download),
   staging dropped, the `import.job.cancelled` event + notify intent written in the same tx
   (§6). Who runs it: the last in-flight chunk observing `cancelled`; if nothing was in
   flight, the cancel verb's own tx finalizes inline; the reaper is the crash backstop.
5. **Cancellable states** are 08 §2.1's exits column (everything non-terminal except
   operator-owned `paused`); cancel-on-cancelled is a 200 no-op (08 §2.3).

### §6 Notifications & lifecycle events via the outbox (G06) 🔲

#### §6.1 Why best-effort is disqualifying here

Today's only import notification is an insert fired from the BullMQ `completed` event handler
(`register.ts:625–645`) — best-effort by its own comment. It fails silently in four ways: a
worker crash between `runImport`'s commit and the handler; the handler's own catch-and-log; a
Redis eviction of the completed event; and the bulk path, which has **no notification at all**.
For a *user-facing promise* ("we'll tell you when it's done" — the async-with-notification
model the whole market runs, 03 §1.1 [30], §6.1 [18]) this is the enqueue-after-commit gap
ADR-0027 exists to close (`workerOutbox.ts:2–5`): a user promised a notification who silently
never gets one is the "imports are broken" ticket regenerating itself. The trust bug is not
slowness; it is loss.

#### §6.2 The producer rule (same-tx, both outboxes)

Every transition a user can observe writes its intents **inside the same `withTenantTx` that
flips `import_jobs.status`**:

| Transition | `event_outbox` (SSE garnish, §4.4) | `worker_outbox` (must-happen work) |
|---|---|---|
| commit → `queued`/`deferred` | `import.job.state_changed` | topic `import.drive` — the drive enqueue itself (§6.4) |
| non-terminal transitions + progress throttle | `state_changed` / `progress` | — |
| terminal (`completed|partial|failed|cancelled`) | terminal event | topic `import.notify` `{jobId, scope, terminalStatus}`; **and** (copy finalize + fast terminal) topics for the dedup/firmographics/masterBackfill rollups |

DB commit ⇒ intent exists; crash anywhere after ⇒ the leaderless relays deliver later —
at-least-once, deduped downstream (Reconciliation #2). The rollup migration retires both
best-effort seams: the sync `completed`-handler enqueues (`register.ts:600–624`) and the bulk
`fireRollups` hook (`register.ts:865–884`, `bulkImports.ts:37–42`) — the rollup jobs
themselves are already idempotent (their own headers say re-run-safe), so at-least-once
publish is sufficient.

#### §6.3 The dispatcher and the effect

The shipped `outboxRelay` gains two registered publishers (a `publishers` map entry each,
`outboxRelay.ts:18–20` — no new relay): `import.drive` → the unified-queue drive producer;
`import.notify` → a dispatch that (a) inserts the in-app notification via
`notificationRepository` **idempotently** — stable key `import-notify:<jobId>:<status>`,
insert-if-absent, so at-least-once publish yields exactly-once *effect*; (b) hands to the
email seam when the user opts in (preference surface = doc 11; provider wiring = doc 14).
Posture, named precisely: **at-least-once delivery, exactly-once effect, eventual by up to
relay lag** — observable as `outboxOldestPendingSeconds` (`metrics.ts:55–56`), alarmed in §8.
A poison intent fails out via the relay's attempts cap into `status='failed'` + alert —
never spins, never blocks its batch (`outboxRelay.ts:58–67`).

#### §6.4 The commit-enqueue gap closes too

Today the API enqueues directly after the control-row tx (`bulkRoutes.ts` →
`enqueueBulkImportDrive`) — the same non-atomic pattern flagged S0 for enrichment
(worker-platform 00 §3). Moving the drive enqueue onto `worker_outbox` (`import.drive`, §6.2)
makes commit⇒drive crash-safe. Cost: one relay-poll latency (~1 s, `outboxRelay.ts:34`) added
to submit-to-start — invisible at import timescales. Fast-mode Phase A keeps its legacy
direct enqueue until the S-Q3 cutover (flag-off = byte-identical, 08 §1.2 discipline).

### §7 Failure-mode table (pre-build: every mode has detection + recovery + invariant) 🔲

| # | Failure | Detection | Recovery | Invariant preserved |
|---|---|---|---|---|
| 1 | **Worker crash mid-chunk** | stalled-lock reclaim (60/30/2, `tuning.ts:24–28`); attempt fails into retry | BullMQ retry replays the chunk; 3-level idempotency makes re-merge a no-op for already-promoted rows (§3) | no double-promote; counters delta only on the committed completion tx; accounting identity holds |
| 2 | **Redis flush / total loss** | DB-vs-Redis divergence: jobs `queued`/`running` in Postgres with zero corresponding Redis jobs; `queue.workers.connected` + depth gauges read wrong-shaped zero (§8) | **DB-backed recovery: the reaper re-enqueues from job/chunk rows** — lease-expired `running` chunks and `queued` jobs past the enqueue SLA re-publish with stable jobIds (dedupe-safe) — db-mgmt-research/05 §5.4/E5 pattern, extended by S-Q5 | Redis is transport, fully reconstructable from Postgres; zero lost jobs by construction |
| 3 | **FileStore unavailable mid-drive** | drive attempt throws; retries per §3 | transient: watermark resume re-drives without re-staging; persistent: job `failed` with PII-free reason after budget — the honest terminal (08 pre-build: losing the object is the one unrecoverable input loss, hence G07's durability bar) | staging is expendable (UNLOGGED) because the object is truth; no partial promote |
| 4 | **Poison row** | validation rejects are per-row outcomes, never job failures (shipped posture, 01 §2.1 hop 8); a row that *crashes* the processor exhausts the chunk's retries | chunk dead-letters (PII-free); band counts into `unprocessed`; job terminalizes `partial`; operator redrive after fix (§3) | one bad row never wedges the queue (bounded-retry-then-verdict, 03 §6.1 [63][77]); DLQ never holds row data |
| 5 | **Relay/dispatcher down** | `outboxOldestPendingSeconds` climbs (shipped gauge) → §8 alert | rows sit `pending`; any worker instance's relay drains on recovery (leaderless — no failover dance) | notifications/rollups delayed, never lost; no duplicate effect (stable-key dedupe) |
| 6 | **Double-drive race** (reaper re-drive vs delayed original, or replayed outbox intent) | none needed — benign by design | stable jobId dedupes at enqueue; a second execution hits watermark resume + `(job_id, chunk_index)` unique + terminal-skip | exactly-once fan-out *effect*; finalize still fires once (atomic completer) |
| 7 | **Crash between terminal commit and anything after** | n/a — the window no longer exists (the G06 fix itself) | terminal tx carries the outbox intents (§6.2); artifact upload re-swept if interrupted (§3) | commit ⇒ every downstream effect eventually happens |
| 8 | **Deferred-promotion leader dies** | promoted-per-tick metric flatlines with `deferred` census > 0 | leader lock expires; the next instance's sweep takes over | `deferred` jobs are durable rows; promotion idempotent (legal-transition guard) |

### §8 Observability & runbooks 🔲

Adopt the worker-platform Phase-4 conventions verbatim — the zero-dep `/metrics` increment now
(counters via `instrument()`, depth gauges, outbox age — `metrics.ts`), the full 10 §4 catalog
names when the OTel pass lands (deferred, per that series):

- **Queue health (per §1 queue):** `queue.depth.waiting/active/delayed`, `queue.dlq.depth`,
  and — the linchpin (10 §4.2) — `queue.oldest_waiting_age`, which separates quiet-by-design
  from stalled, split by priority band so fast-lane wait is its own series.
- **Durations:** `worker.job.duration` histogram per job kind (drive/chunk), feeding the
  fast-lane p95-wait SLO (doc 12) and the chunk-duration envelope.
- **Import-specific:**
  - **Stall detector:** a job `running` with **no counter movement for > 10 min** → alert.
    Implemented in the reaper's tick (it already reads chunk leases): compare counter
    snapshots per running job; emit `import.jobs.stalled`. The durable-truth version of
    "is it stuck?" — the question the give-up toast used to shrug at.
  - **Accounting reconciliation:** 7-bucket identity violations on terminal jobs = 0,
    alertable — an unreconciled total is itself a defect (10 §4.3).
  - `import.jobs.by_state` census gauge (staff feed, §9), `deferred` depth + oldest age,
    notify-delivery lag, backpressure-503 count (~0 in normal operation, §1.3), reaper
    re-enqueue count, draft-reap count (08).
- **Alert catalog (severity per worker-platform 10 §9):** DLQ depth > 0 sustained (S2) ·
  `outboxOldestPendingSeconds` > 60 s (S2; > 10 min S1) · stalled-jobs gauge > 0 (S2) ·
  accounting violation (S1 — data integrity) · oldest-fast-waiting age > SLO (S2) ·
  backpressure 503s firing (S2 — product caps are mis-sized).
- **Runbook pointers (one line each, per truepoint-operations; homes in
  `worker-platform/13-operational-runbooks.md` + db-mgmt-research/05):** *stuck `queued`* →
  run the by-design-vs-fault matrix (worker-platform 03): worker up? Redis reachable? relay
  draining? · *DLQ growth* → inspect PII-free records, fix cause, operator redrive (05 §9.2)
  · *stall alert* → check chunk lease + reaper tick; re-drive if lease-expired · *relay lag*
  → check worker instances + `worker_outbox.status='failed'` rows (a wiring bug, not a retry
  case — `outboxRelay.ts:49–53`) · *Redis flush* → verify reaper recovery via its metric;
  no manual re-submits needed.

### §9 Naming reconciliation — never another "Queued 4" investigation 🔲

An entire audit series was commissioned because a DB census tile reading `Queued: 4 /
Awaiting Confirmation: 1` looked like a fault and was by design (worker-platform 00 §1). The
import redesign adds a dozen states across two surfaces; the same ambiguity would regenerate
the "stuck import" ticket class this series exists to kill. Rules:

1. **Census ≠ depth, labeled as such.** The staff monitor separates *DB-state census* (rows
   by `import_jobs.status`) from *BullMQ depth* (transport backlog) — distinct tiles, distinct
   names — the `dataRoutes` queueDepth-exclusion precedent (worker-platform 00 §2) generalized.
   States that wait on a **human or a gate** (`draft`, `deferred`, `paused`) are never summed
   into any "waiting on worker" number.
2. **User-facing copy maps every state to what is happening and who acts** (final copy is doc
   11's; this table is the contract):

| State | UI copy direction (11 owns wording) | Waits on |
|---|---|---|
| `draft` | "Draft — finish setting up your import" | user |
| `queued` | "Waiting to start" | worker |
| `deferred` | "Queued — will start when a slot frees (N running)" | scheduler (visible cap, 03 §6.1 [18]) |
| `validating` / `staged` | "Preparing your file" | worker |
| `running` | "Importing — X of Y rows" | worker |
| `paused` | "Paused by TruePoint support" | operator (08 §2.1) |
| `completed` | "Done" | — |
| `partial` | "Done — N rows need attention" (+ artifacts) | user (repair loop) |
| `failed` | "Failed — {reason}" | user/support |
| `cancelled` | "Cancelled — rows already imported were kept" | — |

3. **No state name means different things on different surfaces.** Staff console shows the
   raw enum + the census/depth split; the customer UI shows the mapped copy; the API returns
   the raw enum (08 §2.3) — one vocabulary, three renderings, zero translation drift (the
   §4.1 shared derivation function feeds all three).

---

## Pre-build reasoning pass (delta answers — 08's pass covers the shared surface)

- **Source of truth.** Queue/ordering truth: Postgres (`import_jobs` + chunks + the two
  outboxes); Redis holds only claimable work, reconstructable via the reaper (§7 row 2).
  Fairness state: the chunk rows themselves (window = count of non-terminal enqueued chunks).
  Progress: counters (§4.1). Notification-sent: the notification row's stable key. No datum
  has two owners; on divergence Postgres wins.
- **Failure modes.** §7 is the table; every row has detection + recovery + a named invariant.
- **Duplicate prevention.** Stable jobIds at enqueue; 3-level idempotency at merge; stable
  keys at notify; atomic completer at finalize (§1.2, §3, §6.3).
- **Audit.** Actor verbs are 08 §7's in-tx audit rows; worker/relay transitions are evidenced
  by the job/chunk/outbox/notification rows (`published_at`, `attempts`) — support
  reconstructs the full execution timeline from Postgres alone.
- **Security.** No new surface: producers run under `withTenantTx` (outbox rows tenant-scoped
  + RLS'd, `workerOutbox.ts:9–11`); relays read cross-tenant on the owner connection — the
  shipped, sanctioned pattern (`realtimeRelay.ts:5–6`); payloads and DLQ records PII-free by
  contract (`bulkImports.ts:126–129`); notify inserts target only the job creator (doc 10's
  matrix governs any broader audience).
- **Scalability.** The 10x question is chunk throughput and job-row contention: bounded at
  ≤ K writers × ≤ 20 UPDATEs/chunk (§4.2); queue depth bounded by sheds + window (a 2M-row
  import occupies ≤ K queue slots, not 200); event volume O(duration) via the progress
  throttle (§4.4). Envelope numbers: doc 12.
- **Monitoring.** §8; the one-line runbook entries exist per truepoint-operations.
- **Rollback.** Every step is flag-gated or additive: outbox producers dual-gated with 08's
  `IMPORT_V2_ENABLED` (flag-off = today's direct enqueue + best-effort handlers,
  byte-identical); priority lanes are job options; window K=∞ restores enqueue-all; the
  legacy queue survives until S-Q8. No DDL ships from this doc.
- **Worst case.** *Notification storm* (a stuck relay drains 10k pending notify intents):
  bounded by relay batch (25/tick) + the dedupe key — at most one notification per
  job-terminal, ever. *Runaway re-enqueue loop* (reaper × outbox replay): double-execution
  impossible (stable ids); re-publish rate bounded by reaper cadence + attempts caps; the §8
  reaper-re-enqueue metric alarms on anomaly. Both detectable and recoverable; no approval
  gate needed beyond the flags.

---

## Implementation Steps (step IDs — doc 15 sequences; statuses per series legend)

| Step | What ships | DDL | Depends on |
|---|---|---|---|
| **S-Q1** | Unified-queue routing: fast drives/chunks onto `bulk-imports` with priority bands; `tuning.ts` + deadline entries for the unified kinds; legacy queue untouched | No | 08 S-I3 |
| **S-Q2** | Bounded rolling fan-out (window K) in the drive + chunk continuation enqueue; per-workspace cap → `deferred` parking; leader-locked promotion sweep (with 08 S-I10) | No | S-Q1 |
| **S-Q3** | Outbox producers: terminal/committed transitions write `event_outbox` + `worker_outbox` in-tx; drive enqueue moves to `import.drive` topic; rollups move to topics; retire the best-effort handlers (`register.ts:600–645,865–884`) behind the dual-gate | No | 08 S-I3; dual-gate |
| **S-Q4** | Notify consumer: `import.notify` publisher registration + idempotent in-app insert + email seam; delivery-lag metric | No | S-Q3 |
| **S-Q5** | Reaper extension (composes db-mgmt-research/05's `bulk-import-reaper-sweep` + lease columns — owned there): Redis-loss re-enqueue from job/chunk rows; stall detector emit; artifact re-sweep | No (lease DDL owned by 05) | 05's reaper step |
| **S-Q6** | Progress: counter-delta cadence in the fast wrapper + chunk merge; shared derivation fn; SSE event names registered in `@leadwolf/types` (wiring stays dark behind `REALTIME_SSE_ENABLED`) | No | 08 S-I3 |
| **S-Q7** | Metrics + alert catalog (§8): import kinds on `/metrics`, DLQ/outbox-age/stall/accounting alerts, runbook entries landed in worker-platform 13's format | No | S-Q1–S-Q5 |
| **S-Q8** | Legacy `imports` queue retirement: producer switch → drain window → consumer + tuning + DLQ archive removal | No | 08 Phase B; S-Q1–S-Q4 green in CI |

**Zero DDL ships from this doc.** The only queue-adjacent columns (chunk lease pair) are
db-mgmt-research/05's, and both outbox tables are shipped (01 §7.1).

## UI/UX (pointer — doc 11 owns every surface)

Doc 11 consumes: the never-dies poll contract + cadence (§4.3), the state→copy table (§9.2),
the `deferred` visible-backpressure rendering, cancel's "rows kept" copy (§5), notification
preferences + in-app rendering (§6.3), and later the SSE event names (§4.4). Nothing renders
here.

## DB & Backend (summary)

No new tables, no new columns. Code lands in existing homes: `apps/api/src/features/import/`
(producer switch to outbox topic; priority options), `packages/core/src/import/` (window
fan-out, cancel checks, terminal-tx event writes, derivation fn), `apps/workers/src/`
(publisher registrations on the existing relay, reaper extension, tuning entries, notify
consumer), `packages/types` (SSE event names + topic constants — closed vocabularies).

## API (summary)

No new endpoints — 08 §2.3 is the verb table. This doc's contract deltas ride existing
responses: the detail response's derived `percent`/`stage` fields and the guarantee that
`GET /imports/:id` answers for the row's lifetime (§4.3). SSE, when wired, uses the
authenticated stream the reveal feature shipped; event names per §4.4.

## Edge Cases

Cancel-during-finalize (legality guard: terminal wins, cancel 409s — 08 §2.1) · cancel with
zero chunks in flight (verb finalizes inline, §5.4) · relay replays a notify (dedupe no-op,
§6.3) · reaper re-drives a merely-slow job (stable-id dedupe + watermark, §7 row 6) · K below
1 or above total_chunks (clamped; K=∞ = legacy enqueue-all) · workspace at its cap cancels a
running job (next sweep promotes its oldest `deferred`) · sub-2 s import vs the progress
throttle (terminal event supersedes) · chunk completes after operator force-fail
(terminal-skip: merge tx re-checks status, discards) · DLQ redrive of a chunk on a terminal
job (no-op by terminal-skip).

## Testing (hooks — CI-run; this sandbox cannot execute gates)

- **T-Q1 Chunk-replay idempotency:** run a chunk, crash-inject, re-run — identical DB end
  state, counters incremented once, no duplicate `source_imports` rows.
- **T-Q2 Cancel mid-chunk:** cancel during batch i — batch i commits, batch i+1 never runs,
  remainder `unprocessed`, accounting identity exact, artifacts produced, `cancelled` event
  + notification exist.
- **T-Q3 Outbox same-tx:** crash-inject between terminal commit and everything after — on
  restart the relay delivers the event, the notification, and the rollups exactly once each;
  flag-off parity test: producers off ⇒ byte-identical legacy behavior.
- **T-Q4 Fairness under contention:** seed a 200-chunk whale + N fast jobs — fast p95 wait ≤
  one chunk duration; whale in-flight never exceeds K; two whales interleave at window
  granularity.
- **T-Q5 Redis-loss drill:** flush Redis mid-run — reaper reconstructs; every job reaches a
  terminal state; zero manual intervention; zero double-promotes.
- **T-Q6 Notify dedupe:** publish the same notify intent 3× — one notification row.
- **T-Q7 Finalize exactly-once:** concurrent last-chunks race the completer — one finalize,
  one rollup intent set, one terminal event.
- **T-Q8 Stall detector:** freeze a running job's counters — alert fires within the window;
  moving counters never alert.
- **T-Q9 Priority:** mixed enqueue order — fast band always dequeues before waiting copy
  chunks; within a band, FIFO.

## Rollout

S-Q1/S-Q2/S-Q6 ride 08's Phase A dual-gate (dark, internal workspaces first). S-Q3/S-Q4 flip
per-tenant after T-Q3 parity holds in CI — the notification is the first user-visible change
and the safest (additive). S-Q5/S-Q7 are gate-independent hardening (ship any time — they
only observe/recover). S-Q8 waits for Phase B + a full drain. Rollback at every stage = flag
off (direct-enqueue + best-effort handlers return, byte-identical); outbox rows written while
on drain harmlessly after a flip-off (consumers are idempotent). Phase placement: doc 14;
sequencing: doc 15.

## Success Metrics

- **Zero lost jobs** — the headline: every committed import reaches a terminal state, through
  worker crashes and a Redis flush drill (T-Q5 green in CI; §7 row 2 metric clean in prod).
- **Notification delivery ≥ 99.9%**, p95 terminal-commit→in-app < 60 s (relay-lag metric);
  0 duplicate notifications.
- **Fast-lane p95 wait** under mixed load within doc 12's SLO; whale throughput degradation
  under contention < 2× (window math, §2.3).
- **0 accounting-identity violations**; **0 silent DLQ escapes** (every exhaustion produces a
  PII-free record + alert); backpressure-503 count ~0 (product limits engage first).
- **Stall MTTD < 10 min** via the detector — "is it stuck?" answered by a signal, not a
  support ticket (the worker-platform lesson, applied).
- **G06 closed:** repo grep finds no import-path enqueue-after-commit and no best-effort
  user-facing notification; the two retired handlers are gone at S-Q8.
