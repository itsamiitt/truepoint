# 08 — Pipeline Architecture

> **Priority:** P0 · **Effort:** 14–18 eng-weeks · **Phase:** F1–F3
> (phases are defined in 17-phased-implementation-roadmap.md)

## Executive summary

The Forge pipeline is a BullMQ worker fleet that runs, consumes CPU, and moves jobs — and
produces almost no data. Of nine queues, three are dead (no producer, no consumer), and the
live chain parse → ai-extract → resolve → verify is broken at every load-bearing joint: parse's
silver upserts can only fail because the in-memory parser registry's string ID is written into
a uuid foreign key against a never-populated `parser_versions` table (fact-pack §3.2);
extraction runs real Anthropic calls and then discards the result (fact-pack §3.3); resolve is
a pass-through; verify inserts a hardcoded-confidence review task. The sync and maintenance
queues have no producer anywhere in the repo, so the transactional outbox fills and never
drains — gold records can never reach `master_*` (fact-pack §4.2). Reliability posture matches:
verify and extract handlers are non-idempotent on at-least-once queues, the DLQ is
`console.error`, quarantine is `console.warn`, no queue sets `removeOnComplete`, the AI budget
is an in-memory map, and the maintenance leader lock expires mid-run. The irony is that the
frozen planning suite specified the right architecture — a record-centric state machine with
three idempotency keys, two failure lanes, and per-hop lineage (fact-pack §2.1) — and the build
dropped exactly those parts. The headline recommendation (fact-pack S.2#7): keep BullMQ, make
Postgres the pipeline's source of truth — a per-record pipeline-state table, transactional
outbox everywhere, stage idempotency keys as unique constraints, and reconciliation sweeps —
with persisted DLQ/quarantine plus redrive tooling, real schedulers, per-tenant fairness, and
Hatchet/DBOS only at stated triggers. Never Temporal self-hosted; never Airflow/Dagster.

## Current state

### Queue and worker inventory

`apps/forge-worker/src/register.ts` creates nine queues on **one shared IORedis connection**
(register.ts:31, 38-48), all `forge-`prefixed to avoid colliding with the ~25 main-app queues
(fact-pack §2.3). Five workers boot unconditionally; sync only when
`FORGE_SYNC_EGRESS_ENABLED` (register.ts:92-101). As-built topology:

| Queue | Producer | Consumer | Concurrency | Retry | DLQ | Status |
|---|---|---|---|---|---|---|
| forge-capture-ingest | none | none | — (8 configured) | 3× exp 5s | — | **DEAD** |
| forge-parse | forge-api landEnvelope, mid-tx (`server.ts:54-57`; `ingest.ts:131`) | parse worker | 8 | 3× exp 5s | console.error | live, writes fail (P-08.1) |
| forge-ai-extract | parse processor (`processors.ts:97`) | extract worker | 4 | 3× exp 15s | console.error | live, output discarded |
| forge-extract | none | none | — (4 configured) | 3× exp 15s | — | **DEAD** |
| forge-resolve | extract processor (`processors.ts:127`) | resolve worker | 2 | 3× exp 10s | console.error | pass-through |
| forge-verify | resolve processor (`processors.ts:134`) | verify worker | 4 | 3× exp 10s | console.error | live, hardcoded output |
| forge-quality | none | none | — (4 configured) | 3× exp 10s | — | **DEAD** |
| forge-sync | **none** | sync worker (flag-gated) | 4 | 5× exp 30s | console.error | never fires |
| forge-maintenance | **none** | maintenance worker | 1 | 2× exp 60s | console.error | never fires |

Retry policies are bounded exponential with 0.5 jitter (`retryPolicies.ts:10-26`); per-stage
deadlines run via a `withDeadline` race that does not cancel orphaned work and classifies the
deadline error as retryable (`tuning.ts:16-26`; fact-pack §4.2). No queue sets
`removeOnComplete`/`removeOnFail` (`register.ts:33-36` — `defaultJobOptions` carries only
attempts/backoff), in contrast to the platform queues which set both (fact-pack §4.2).

### The stage chain as-built

**S0 land** (`packages/forge-core/src/ingest.ts`, wired at
`apps/forge-api/src/server.ts:54-57`): the whole envelope lands in one `withForgeTx`; the S3
PUT for >8KB payloads happens inside the open transaction; the BullMQ enqueue with
`jobId = contentHash` happens mid-transaction (ingest.ts:131). A parse job can execute before
commit; the processor treats a missing row as done (`processors.ts:53-54`) and jobId dedup
plus no `removeOnComplete` blocks re-enqueue — a permanently unparsed capture. Rolled-back
envelopes leave orphan jobs (fact-pack §3.3; the edge-side view is
03-data-ingestion-architecture.md P-03.5).

**S1 parse** (`processors.ts:50-99`): fetches bronze, computes a shape fingerprint, runs
`runParse` with a quarantine lane that is `console.warn` only (processors.ts:78-82) — drifted
captures are recorded nowhere. The upsert maps the registry's string version ID into
`parsed_records.parser_version_id`: `registerBuiltinParsers` registers
`id: "voyager-profile-1-0-0"` (`packages/forge-core/src/parsers/index.ts:17-24`),
`runParse` passes `selection.version.id` through (`parseStage.ts:96-98`), and the column is
`uuid NOT NULL REFERENCES forge.parser_versions (id)`
(`packages/db/src/migrations/0070_forge_schema.sql:75`) against a table that is never
INSERTed (fact-pack §3.2). Production parse upserts can only fail (uuid cast + FK
violation). Additionally the upsert omits `channels`/`blockKey`, so
`email_blind_index`/`block_key` on silver are always NULL — ER blocking and DSAR lookup on
silver are impossible (fact-pack §3.2). gzip payloads are never decompressed before parsing
(fact-pack §3.3).

**S2 ai-extract** (`processors.ts:102-129`): sends the **full raw payload** to Anthropic as
"residue" (processors.ts:108), meters via `insertExtractionRun`, and then **discards the
extraction result** — the return value of `runExtraction` is unused and no candidate store
exists (processors.ts:112-127, verified; fact-pack §3.3). It enqueues resolve regardless of
outcome (processors.ts:127). The budget is `inMemoryBudgetStore()` captured in the processor
closure (processors.ts:103) — resets on restart, keyed `rawCaptureId:tenantId` (per-capture,
not per-tenant/day), limit 1000 units (processors.ts:30). Token counts are returned by the
port but never persisted to `extraction_runs` (fact-pack §3.2).

**S3 resolve** (`processors.ts:132-136`): pure pass-through to verify. No ER runs; forge-core
`er.ts` has zero production callers (fact-pack §3.1, §3.3). ER target design is
05-entity-resolution.md.

**S4 verify** (`processors.ts:139-150`): a plain `insertReviewTask` with hardcoded
`taskType: "ai_low_confidence"`, `confidence: 0.5`, `priority: 50` — `computePriority` in
forge-core is never called (fact-pack §3.3). The INSERT has no uniqueness, so every retry
duplicates the task (fact-pack §4.2). Promotion itself (`POST /v1/review/approve` →
`promoteVerifiedRecord`, the atomic 8-row set including the outbox row) is real and
idempotent on content_hash (fact-pack §3.3) — the one stage contract the build kept.

**S5 sync** (`processors.ts:153-178`): drains 50 outbox rows `FOR UPDATE SKIP LOCKED` in one
tx, applies each under a separate `withErTx`, then marks dispatched in a third tx — the
locks released at drain-commit defeat the SKIP LOCKED contention claim, there is no
`ORDER BY`, and a crash between apply and mark re-applies the batch (survivable only because
`processed_sync_events` dedups by event id — fact-pack §6.1). The hex→base64 conversion is
done for `contentHash` (processors.ts:163) but **not** for `emailBlindIndex`, which is the
blind-index seam break (fact-pack §6.1; owned by doc 11). The payload lacks resolver keys —
an acknowledged TODO in the code (processors.ts:164-166). And none of this ever executes:
repo-wide, there is no `.add()` call, no repeatable job, and no scheduler for forge-sync
(fact-pack §4.2, corroborated by three audit agents).

**Maintenance** (`processors.ts:181-189`): a leader-elected `console.info("leader tick")`;
the reconcile() implementation was "dropped in the nest" (fact-pack §3.3). No producer
exists, so even the no-op never fires. The leader lock TTL is 60s (`register.ts:64-65`)
against a 120s processor deadline (`tuning.ts:25`) — leadership lapses mid-run and two
replicas can overlap (fact-pack §4.2); `withLeaderLock` has no heartbeat extension
(`leaderLock.ts:21-35`).

### Reliability posture

- **DLQ:** `buildDeadLetter` produces a PII-free record on exhaustion — and the handler
  `console.error`s it (`register.ts:77-86`; `deadLetter.ts:12-26`). Not persisted, not
  replayable (fact-pack §4.2).
- **Shutdown:** SIGTERM triggers a 30s close race, then `process.exit(0)`
  (`apps/forge-worker/src/index.ts:8,43-55`). In-flight jobs are droppable; the file header's
  "safe because every processor is idempotent" (index.ts:3) is false for verify and extract
  (fact-pack §4.2).
- **Health:** worker `/ready` flips 503 only on shutdown; every other path returns 200 with
  no Redis/PG/S3 dependency checks (index.ts:20-34). forge-api's `/ready` is a static
  `{ready: true}` (fact-pack §4.1).
- **Observability:** two static gauges (`forge_workers_up`, `forge_worker_count`,
  index.ts:26-31); no queue depth, age, latency, failure, or stage metrics despite
  forge-core shipping unused SLO/alert/autoscale helpers (fact-pack §4.4, §3.1).
- **Redis:** one shared connection for all queues, workers, and the leader lock
  (register.ts:31); no dedicated instance, no noeviction guarantee documented; no
  `removeOnComplete` anywhere — the #1 BullMQ outage class (fact-pack §10.2).

### Planned intent (labeled as intent, not reality)

The planning suite (docs/planning/forge/06 stage contracts, 12 worker orchestration —
fact-pack §2.1) specifies: stage contracts S0…S8+M (ingest→parse→AI-extract→quality→resolve→
review→promote→outbox→sync) over a **record-centric state machine**; effectively-once via
three idempotency keys (content_hash at ingest; (raw_id, parser_version) at parse; outbox
event id at sync); supersede-not-duplicate versioned replay; a schema-drift
fingerprint→quarantine lane distinct from the DLQ (two lanes); saga/compensation; per-hop
lineage (OpenLineage + PROV); one queue per stage plus `<queue>-dlq` twins; hand-built
PII-free DLQ; ai-extract pinned concurrency-1 until an atomic budget lease; lockDuration
120s+; priority lanes (live=1, backfill=5, DLQ-replay=8); leader-locked sweeps; autoscale on
queue depth; 30s graceful drain. The build kept the queue names, the retry arithmetic, and
the drain timeout — and dropped the state machine, both failure lanes' persistence, the
budget lease, the DLQ twins, and the priority lanes. The plan's semantics were right; this
document's target restores them on the simplest substrate that satisfies them.

## Problems identified

BUG = wrong today; GAP = missing capability; DEBT = works, won't scale/maintain; RISK =
exposure. Canonical build-defect inventory: doc 01.

1. **P-08.1 — BUG.** Silver writes can only fail: in-memory registry string
   `"voyager-profile-1-0-0"` (`parsers/index.ts:18`) is written into the
   `parsed_records.parser_version_id` uuid FK (0070:75) against a never-populated
   `parser_versions` table (fact-pack §3.2). The entire DAG below S1 operates on data that
   cannot exist. Fix = persist the parser registry (F1 mandate, fact-pack S.1).
2. **P-08.2 — BUG.** Extraction results are discarded — `runExtraction`'s return value is
   unused and no candidate store exists (`processors.ts:112-127`); resolve is enqueued
   regardless of outcome (fact-pack §3.3). The pipeline pays Anthropic for output it throws
   away.
3. **P-08.3 — BUG.** No producer for forge-sync or forge-maintenance anywhere in the repo —
   no `.add()`, no repeatable job, no scheduler (fact-pack §4.2). The outbox fills and never
   drains; gold never reaches `master_*`; the maintenance sweep never ticks. The pipeline's
   last mile does not exist.
4. **P-08.4 — BUG.** Verify is non-idempotent (plain INSERT duplicates review tasks on every
   retry) and content-free (hardcoded `ai_low_confidence`/0.5/50, `computePriority` unused)
   (`processors.ts:139-150`; fact-pack §3.3, §4.2). Review queues fill with duplicate,
   unranked work — and review_tasks are never claimed/resolved, so the queue is unbounded
   (fact-pack §3.2).
5. **P-08.5 — BUG.** Extract is non-idempotent: every retry re-bills Anthropic and
   duplicates metering rows (fact-pack §4.2). Combined with the retryable deadline class,
   a slow provider window multiplies spend 3×.
6. **P-08.6 — RISK.** DLQ is `console.error` (`register.ts:85`) — failed jobs are
   unrecoverable the moment the log rotates. The plan's persisted, PII-free, replayable DLQ
   (fact-pack §2.1) does not exist.
7. **P-08.7 — BUG.** Quarantine lane is `console.warn` (`processors.ts:78-82`) — NO_PARSER/
   SHAPE_DRIFT/parse-quarantine outcomes are recorded nowhere, so schema drift is invisible
   and unreplayable (fact-pack §3.3). The plan's DLQ-vs-quarantine two-lane model collapsed
   into stdout.
8. **P-08.8 — DEBT.** No `removeOnComplete`/`removeOnFail` on any forge queue
   (`register.ts:33-36`) — unbounded Redis growth, the #1 BullMQ outage class (reported
   10GB from 4.5M leftover jobs; fact-pack §10.2, §4.2).
9. **P-08.9 — BUG.** Mid-transaction enqueue + S3-PUT-inside-tx at S0 (same defect as
   P-03.5, pipeline-side): parse-before-commit races, missing-row-treated-as-done, orphan
   jobs on rollback (`ingest.ts:131`; `processors.ts:53-54`; fact-pack §3.3).
10. **P-08.10 — RISK.** AI budget is an in-memory map in the processor closure
    (`processors.ts:103`), reset on every restart, keyed per-capture rather than
    per-tenant/day (fact-pack §3.3). The plan's per-tenant budget lease and the two hard
    scale ceilings (ai-extract spend, human review — fact-pack §2.1) have no enforcement.
11. **P-08.11 — BUG.** Maintenance leader-lock TTL 60s < 120s processor deadline
    (`register.ts:65`; `tuning.ts:25`): leadership lapses mid-run; two replicas can overlap
    on what is supposed to be a singleton sweep (fact-pack §4.2).
12. **P-08.12 — RISK.** Shutdown force-closes after a 30s race then `process.exit(0)`
    (index.ts:43-55); with non-idempotent verify/extract (P-08.4/5) a deploy can both drop
    and duplicate work (fact-pack §4.2).
13. **P-08.13 — RISK.** One shared IORedis connection for nine queues, six workers, and the
    leader lock (register.ts:31); BullMQ workers use blocking commands and the vendor
    guidance is dedicated connections — a stalled command head-of-line-blocks everything
    (fact-pack §4.2; https://docs.bullmq.io/).
14. **P-08.14 — GAP.** Health is liveness-only: `/ready` never checks Redis/PG/S3
    (index.ts:20-34) and forge-api's is static (fact-pack §4.1) — orchestration cannot
    distinguish a healthy worker from one that cannot reach any dependency.
15. **P-08.15 — GAP.** No per-record pipeline state exists anywhere: `raw_captures.status`
    is never updated past 'landed' (fact-pack §3.2), there is no stage/status/attempt row,
    so progress is unobservable, recovery is impossible, and "where is record X" has no
    answer. The plan's record-centric state machine (fact-pack §2.1) was the design's spine
    and is absent.
16. **P-08.16 — DEBT.** Sync drain uses three separate transactions (drain, apply-per-row,
    mark) with locks released at drain-commit and no ORDER BY (`processors.ts:153-178`) —
    the SKIP LOCKED claim protects nothing, ordering is unspecified, and crash-between-
    apply-and-mark re-delivers the whole batch (fact-pack §3.3, §6.1).
17. **P-08.17 — DEBT.** Two worker platforms: forge-worker re-implements deadLetter/
    leaderLock/retryPolicies/tuning/withDeadline with the same filenames as apps/workers,
    all differing (fact-pack §6.6#10). Every reliability fix must now be made twice.

## Research findings

- **BullMQ envelope.** ~8.3K jobs/s at 100 concurrency in benchmarks; ~50K jobs/min on one
  Redis with 8 workers — the target load (2.5M–25M raw/day ≈ 29–290/s sustained,
  fact-pack §2.5) is an order of magnitude below the comfort zone. Keep it
  (fact-pack §7.6, §10.2; https://docs.bullmq.io/).
- **The #1 outage class is Redis memory:** jobs without `removeOnComplete`/`removeOnFail`
  (age+count) grow unbounded; `maxmemory-policy noeviction` is mandatory (eviction silently
  corrupts queues); AOF everysec + RDB on a dedicated instance — and even then failover can
  lose acked jobs: **Redis is not a system of record** (fact-pack §10.2;
  https://docs.bullmq.io/guide/queues/auto-removal-of-jobs).
- **Transactional outbox** is the pattern that matters most: domain row + outbox row in one
  tx, relay to the queue, idempotent consumer — exactly-once handoff relative to commit
  (fact-pack §10.4; https://microservices.io/patterns/data/transactional-outbox.html).
- **Idempotency keys per stage:** `(tenant_id, record_id, stage, input_hash)` as a unique
  constraint with cached-response replay — the Stripe pattern (fact-pack §10.6;
  https://brandur.org/idempotency-keys; https://stripe.com/blog/idempotency).
- **Retry discipline:** retryable (timeout/429/5xx/deadlock) vs terminal
  (validation/4xx/poison) — terminal skips retries straight to DLQ/quarantine; exponential
  backoff with **full jitter** (AWS canon:
  https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/); 3–5 attempts
  then DLQ; DLQ entries carry payload ref + attempts + first-failure + error signature, with
  rate-limited, idempotency-verified redrive — "a control point, not a deferral"
  (fact-pack §10.6).
- **Circuit breakers:** opossum is the de facto Node standard; per-provider breakers +
  bulkheads (fact-pack §10.6; https://github.com/nodeshift/opossum).
- **Per-tenant fairness:** BullMQ Pro groups (~$95/mo intro, $995–1,395/yr) or app-level
  round-robin (fact-pack §10.2; https://docs.bullmq.io/bullmq-pro/groups).
- **Durable workflow engines** — adopt only at triggers (hand-rolled state machines for
  verify/HITL exceed 2–3 nontrivial workflows; backfills need pause/resume/fork; enterprise
  auditable workflow history). Ranked for this stack: Hatchet (MIT, Postgres-backed,
  first-class TS, verified 2K runs/s at 83% CPU on an 8-vCPU RDS;
  https://github.com/hatchet-dev/hatchet) > DBOS Transact (durable execution as a library
  checkpointing to existing Postgres — zero new infra; https://www.dbos.dev/) > Inngest >
  Temporal Cloud (never self-hosted: 4 services + DB, est. $2.5–4.5K/mo + SRE, single-source
  estimate). Never Airflow/Dagster/Prefect/Kestra as the core — a Python/JVM second stack
  (fact-pack §10.3, §10.5, S.2#7).
- **Steal the orchestrator concepts, not the tools:** software-defined assets (stages as
  declarative assets with provenance), partitioned backfills (id-range/date buckets with
  per-partition status/retry — never 100M individual jobs), freshness SLOs per asset
  (fact-pack §10.5; https://dagster.io/).
- **SKIP LOCKED ceilings:** lock-scan overhead under hundreds of pollers and MVCC bloat are
  real but far above this workload; pgmq peaks 11.3K jobs/s, pg-boss ~2.4K/s — Postgres
  queues are viable, but the chosen posture (PG state + BullMQ transport) gets the
  durability without migrating transports (fact-pack §10.4; https://github.com/pgmq/pgmq;
  https://github.com/timgit/pg-boss).
- **Observability:** propagate OTel context through job payloads (inject at enqueue,
  extract in worker; official bullmq-otel, Nov 2024 — fact-pack §10.2); canonical staleness
  signal is **age-of-oldest**, not depth; page on burn rate and oldest-age > 5× SLO; SigNoz
  as the single-backend stack for a small team (fact-pack §10.8; https://signoz.io/).

## Enterprise best practices

The distilled bar for a ZoomInfo/Apollo-class pipeline:

1. **The database is the pipeline's source of truth;** queues are replaceable transport. A
   Redis wipe is a re-enqueue, not an incident.
2. **Effectively-once = at-least-once delivery + idempotent apply,** enforced by unique
   constraints, not by handler discipline.
3. **Two failure lanes, both persisted:** DLQ (operational failure — retry exhausted) and
   quarantine (data failure — drift/validation), each with browse + redrive tooling.
4. **Every record answers "where am I, since when, why":** stage, status, attempt, error
   class, cost — queryable, aggregated to freshness SLOs per stage.
5. **Schedulers are first-class:** relays and sweeps are repeatable jobs with leader locks
   whose TTL exceeds the work deadline, plus reconciliation as the safety net for every
   event that can be missed.
6. **Spend is a durable lease:** provider budgets live in Redis/PG with atomic acquire,
   never process memory.
7. **Fairness is structural:** one tenant's backfill cannot starve another's live capture —
   groups or round-robin, plus priority lanes (live > backfill > redrive).
8. **Backfills are partitioned assets** with per-partition status, pause/resume, and
   bounded producers — never N million individual jobs.

## Recommended architecture

### Postgres as the pipeline spine (keep BullMQ as transport)

```text
            ┌──────────────────────────── Postgres (forge schema) ────────────────────────────┐
            │  raw_captures / capture_claims          pipeline_state (per record × stage)     │
            │  parsed_records (idempo: raw×parser)    pipeline_outbox (tx-enqueue intents)    │
            │  extraction_candidates (new, doc 04)    dead_letters / quarantine (persisted)   │
            │  review_tasks (unique-keyed)            backfill_runs / backfill_partitions     │
            │  verified_records + sync_outbox         ai_budget_leases (durable, per-tenant)  │
            └───────┬──────────────────────────────────────────────▲───────────────────────────┘
                    │ outbox relay (leader, repeatable)            │ reconciliation sweep
                    ▼                                              │ (repeatable, leader)
            ┌── BullMQ on dedicated Redis (noeviction, AOF) ───────┴───────────────┐
            │ forge-parse → forge-ai-extract → forge-resolve → forge-verify        │
            │ forge-sync (relay-fed) · forge-maintenance (scheduler-fed)           │
            │ per-queue removeOnComplete/Fail · priority lanes: live 1 / backfill 5│
            │ / redrive 8 · per-tenant fairness (Pro groups or app round-robin)    │
            └──────────────────────────────────────────────────────────────────────┘
   Workers: idempotent by constraint; breakers (opossum) per provider (Anthropic, S3);
   OTel spans linked across hops; DLQ/quarantine writes are PG rows; console surfaces
   browse + redrive (doc 13).
```

BullMQ is demoted to dumb, replaceable transport (fact-pack §10.9 Phase 1): every enqueue is
the projection of a PG intent row, every completion is a PG state transition, and a nightly
(plus on-demand) reconciliation sweep re-enqueues any record whose state says pending but
whose job is gone. Redis loss becomes a non-event.

### Per-record pipeline state (DDL sketch)

```sql
CREATE TABLE forge.pipeline_state (
  content_hash   text NOT NULL,               -- record identity (bronze key)
  stage          text NOT NULL,               -- 'parse'|'extract'|'resolve'|'verify'|'promote'|'sync'
  status         text NOT NULL DEFAULT 'pending',  -- pending|running|done|dead|quarantined|superseded
  attempt        integer NOT NULL DEFAULT 0,
  input_hash     text,                        -- stage idempotency component (e.g. parser_version)
  error_class    text,                        -- retryable|terminal|deadline
  last_error     text,                        -- truncated, PII-free
  cost_micros    bigint,                      -- per-stage spend attribution (extract)
  tenant_id      uuid,                        -- claim-derived attribution (03 §claims)
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (content_hash, stage)
) PARTITION BY RANGE (updated_at);            -- pg_partman in F3 (fact-pack S.1)

CREATE INDEX idx_pipeline_state_lag ON forge.pipeline_state (stage, status, updated_at);

CREATE TABLE forge.pipeline_outbox (          -- transactional enqueue intents
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue        text NOT NULL,
  job_id       text NOT NULL,                 -- deterministic (see idempotency keys)
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- refs only, never payload bodies
  available_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  CONSTRAINT uniq_pipeline_outbox_job UNIQUE (queue, job_id)
);

CREATE TABLE forge.dead_letters (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue         text NOT NULL,
  job_id        text NOT NULL,
  content_hash  text,
  error_class   text NOT NULL,
  reason        text NOT NULL,                -- truncated, PII-free (deadLetter.ts contract)
  attempts_made integer NOT NULL,
  first_failed_at timestamptz NOT NULL DEFAULT now(),
  redriven_at   timestamptz,
  redrive_result text
);

CREATE TABLE forge.quarantine (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_capture_id uuid NOT NULL,
  route         text NOT NULL,                -- NO_PARSER|NO_ACTIVE_VERSION|SHAPE_DRIFT|PARSE_QUARANTINE
  reason        text NOT NULL,
  fingerprint   text,
  resolved_at   timestamptz,
  resolution    text                          -- reparsed|new_parser|discarded
);
```

The land transaction (03-data-ingestion-architecture.md) writes `pipeline_state('parse',
'pending')` + a `pipeline_outbox` row; the relay dispatches post-commit. This closes P-08.9
and P-08.15 with one mechanism.

### Effectively-once, spelled out

At-least-once delivery everywhere + idempotent apply enforced by constraints:

| Stage | Idempotency key (unique constraint) | Duplicate delivery becomes |
|---|---|---|
| S0 land | `raw_captures.content_hash` (0070:28) + `capture_claims (tenant_id, content_hash)` | no-op / claim_count++ |
| S1 parse | `parsed_records (raw_capture_id, parser_version_id)` (0070:90) — already exists, dead until P-08.1 | converging upsert |
| S2 extract | new `extraction_candidates (content_hash, extract_schema_version, model)` unique + content-hash result cache (sha256(payload+prompt_ver+schema_ver), fact-pack §11.2) | cache hit, $0, no re-bill |
| S2 metering | `extraction_runs` gains unique `(job_id, task, extract_schema_version)` | single metering row |
| S4 verify | `review_tasks` gains unique partial index `(subject_ref, task_type) WHERE status='open'` | single open task |
| Promote | `verified_records.content_hash` (0070:133) — already correct | converging 8-row set |
| S5 sync | outbox event id + `processed_sync_events` dedup on the apply side (fact-pack §6.1) | suppressed replay |
| Enqueue | `pipeline_outbox (queue, job_id)` + BullMQ jobId | single dispatch |

These are the plan's three keys (fact-pack §2.1) restored, plus the extract/verify keys the
build's non-idempotent handlers made necessary (P-08.4, P-08.5). Handlers also wrap each
stage in `pipeline_state` transitions (`pending→running→done`) in the same transaction as
their writes, so state and data cannot diverge.

### Scheduler design (fixes P-08.3, P-08.11)

- **Sync relay:** a BullMQ repeatable job (Job Scheduler / `upsertJobScheduler`) every 5s on
  forge-sync, plus an immediate `.add()` fired post-commit by promotion (latency path). The
  drain becomes: one transaction claims N rows `FOR UPDATE SKIP LOCKED ORDER BY created_at`
  **and marks them dispatched with a lease timestamp**; apply happens per-row under
  `withErTx`; a sweeper re-pends leases older than the deadline. Crash-safe without the
  three-tx re-apply window (P-08.16).
- **Maintenance:** repeatable every 60s; leader lock TTL raised above the 120s deadline
  (e.g., 180s) **and** the lock gains heartbeat extension at half-TTL (extend-if-owner Lua,
  same compare-token pattern as release) so a long sweep retains leadership (P-08.11).
  Sweep contents: reconciliation (pipeline_state vs queues vs silver/gold), blob GC for
  pre-tx S3 orphans (03 §land restructure), outbox lease recovery, Redis-vs-PG drift
  counters.
- **Reconciliation cadence:** every 15 min incremental (records stuck `pending`/`running`
  beyond 5× stage SLO are re-enqueued or dead-lettered), nightly full diff (fact-pack §10.9
  Phase 1, §10.6 "reconciliation sweeps … simpler self-healing").

### Retry taxonomy, breakers, backpressure, fairness

- **Taxonomy:** classify at throw-site into retryable (timeout/429/5xx/deadlock/deadline),
  terminal (validation/4xx/poison → straight to `dead_letters` or `quarantine`, no retry
  burn) (fact-pack §10.6). Full jitter replaces the fixed 0.5 jitter.
- **Breakers:** opossum per provider — Anthropic (extract) and S3 (blob fetch) — with
  bulkhead concurrency caps matching `tuning.ts`; breaker-open fails fast to retryable,
  never spends attempts against a down provider.
- **Backpressure:** bounded producers on bulk lanes (imports enqueue at most K outstanding
  chunks); queue-depth + age thresholds pause upstream producers and shed `backfill`
  priority before `live`; ai-extract additionally gated by the durable budget lease
  (per-tenant/day in Redis/PG — replaces the in-memory map, P-08.10; F2 per fact-pack S.1).
- **Fairness:** per-tenant round-robin at the producer (app-level) now; BullMQ Pro groups
  ($95/mo intro) when tenant counts make app-level rotation clumsy (fact-pack §10.2,
  S.1 F2). Priority lanes: live=1, backfill=5, DLQ-redrive=8 (the plan's numbers,
  fact-pack §2.1).

### Target queue topology

| Queue | Producer | Consumer | Conc. | Retry | DLQ | Freshness SLO (p95) |
|---|---|---|---|---|---|---|
| forge-parse | outbox relay (post-commit) | parse worker | 8 | 3× full-jitter 5s | forge.dead_letters | parsed ≤ 5 min from land |
| forge-ai-extract | parse handler via outbox | extract worker | 4 (budget-gated) | 3× full-jitter 15s | forge.dead_letters | candidates ≤ 15 min |
| forge-resolve | extract handler via outbox | resolve worker (ER v1, 05-entity-resolution.md) | 2 | 3× full-jitter 10s | forge.dead_letters | resolved ≤ 30 min |
| forge-verify | resolve handler via outbox | verify worker | 4 | 3× full-jitter 10s | forge.dead_letters | task ranked ≤ 30 min |
| forge-sync | repeatable relay 5s + promote hook | sync worker | 4 | 5× full-jitter 30s | forge.dead_letters | outbox oldest-pending ≤ 5 min |
| forge-maintenance | repeatable 60s | maintenance worker (leader) | 1 | 2× 60s | forge.dead_letters | tick gap ≤ 3 min |
| forge-capture-ingest, forge-extract, forge-quality | — | — | — | — | — | **retired** (quality's checks become in-stage validators + the doc 04 quality workstream) |

All queues set `removeOnComplete: {age: 3600, count: 1000}` / `removeOnFail: {age: 86400}`
(P-08.8); workers get dedicated Redis connections and the fleet moves to a dedicated Redis
instance with `noeviction` + AOF everysec (P-08.13; fact-pack §10.2, §10.9 Phase 0).

### Crash-recovery walk-through, per stage

Today vs target, for a crash (or SIGKILL after the 30s drain) at the worst moment:

- **S0 land, after S3 PUT / before commit.** Today: orphan blob + possibly-consumed parse
  job for a row that never lands; if the job ran first, the capture is permanently unparsed
  (P-08.9). Target: blob is content-addressed garbage (GC'd by maintenance); no outbox row
  ⇒ no job; client retries the envelope under its Idempotency-Key and converges.
- **S1 parse, mid-handler.** Today: BullMQ redelivers; upsert would converge — except every
  parse write fails anyway (P-08.1); quarantine outcomes vanish with the process (P-08.7).
  Target: redelivery hits the `(raw_capture_id, parser_version_id)` upsert; state row
  flips `running→pending` via lease timeout; quarantine rows are PG-durable.
- **S2 extract, after the Anthropic call / before metering.** Today: retry re-bills the
  provider and double-meters (P-08.5). Target: content-hash result cache returns the stored
  answer for $0; the metering unique key absorbs the duplicate; the budget lease was
  debited once, durably.
- **S4 verify, mid-handler.** Today: duplicate open review task per retry (P-08.4).
  Target: the partial unique index makes redelivery a no-op.
- **Promote, mid-8-row-set.** Today and target: single transaction, idempotent on
  content_hash — already correct (fact-pack §3.3); target adds the pipeline_state flip in
  the same tx.
- **S5 sync, between apply and mark.** Today: whole batch re-applies (saved only by
  `processed_sync_events`), and only if anything produced sync jobs at all — nothing does
  (P-08.3, P-08.16). Target: claim-with-lease marks rows before apply; re-apply of an
  applied row is suppressed by event-id dedup; lease sweeper recovers stuck rows in order.
- **Worker fleet dies entirely (Redis flush, VM loss).** Today: every in-flight and queued
  job is gone; no record of what was pending exists (P-08.15). Target: reconciliation
  re-enqueues everything `pending`/`running` from `pipeline_state` — the drill is a
  non-event by construction (fact-pack §10.9 Phase 1).

### Partitioned backfills (asset model)

Reprocessing (new parser version, ER re-run, R2 replay) is first-class, borrowing
software-defined-asset and partition concepts (fact-pack §10.5): a `backfill_runs` row
(asset = stage, parser/schema version, reason) fans out `backfill_partitions` (id-range or
day buckets over bronze, 1–10K records each), each partition a single chunk job at
`backfill` priority with per-partition status/retry/pause/resume. Supersede-not-duplicate:
re-parses write new `parsed_records` versions and mark predecessors `superseded` (0070:84),
per the plan's replay contract (fact-pack §2.1). Never one job per record (fact-pack §10.7).

### Durable-engine trigger criteria

Adopt Hatchet (or DBOS as a library if avoiding new infra) only when one of: (a) the
verify/HITL DAG exceeds 2–3 nontrivial hand-rolled state machines; (b) backfills need
pause/resume/fork beyond the partition table's semantics; (c) an enterprise deal requires
auditable workflow history (fact-pack §10.3, S.1 F3). Until a trigger fires, the
pipeline_state + outbox substrate above is deliberately sufficient. Never Temporal
self-hosted; never Airflow/Dagster (fact-pack S.2#7).

### Worker-primitive convergence

One shared worker platform package (target: `packages/worker-platform`, extracted from
apps/workers' proven register/retryPolicies/deadLetter/leaderLock/outboxRelay per ADR-0027 —
fact-pack §2.3) consumed by both apps/workers and apps/forge-worker; forge-worker's five
same-named local copies (`deadLetter.ts`, `leaderLock.ts`, `retryPolicies.ts`, `tuning.ts`,
`withDeadline.ts`) are deleted (P-08.17; fact-pack §6.6#10). The platform package gains the
pieces neither had: full jitter, terminal-class routing, persisted DLQ writer, heartbeat
leader lock, per-queue removeOn* defaults. Duplication convergence order is fixed by
S.2#2 (blind index + content hash first; worker primitives in this doc's F2 window).

## Implementation details

Dependency-ordered; file paths are targets.

**F1 — make the built pipeline real (weeks 0–8; fact-pack S.1):**

1. **Producers first** (nothing downstream is testable without them): repeatable schedulers
   for forge-sync + forge-maintenance (`apps/forge-worker/src/register.ts` gains
   `upsertJobScheduler` calls); leader-lock TTL 180s + heartbeat extension
   (`apps/forge-worker/src/leaderLock.ts`) (P-08.3, P-08.11).
2. **Persist the parser registry:** seed `forge.parsers`/`forge.parser_versions` from the
   in-memory registrations at boot (idempotent upsert keyed (source, endpoint, version));
   `runParse` resolves the row uuid; migration note: no data to fix — silver is empty
   because writes always failed (P-08.1; registry lifecycle detail in doc 04's scope).
3. **Idempotency constraints migration:** review_tasks partial unique, extraction_runs
   unique, `pipeline_state`/`pipeline_outbox`/`dead_letters`/`quarantine` DDL (sketches
   above); wire quarantine + DLQ writers (`processors.ts`, `register.ts` failed-handler)
   (P-08.4 uniqueness half, P-08.5 metering half, P-08.6, P-08.7).
4. **Land restructure with 03-data-ingestion-architecture.md:** S3 PUT pre-tx, outbox row
   in-tx, relay dispatch post-commit (P-08.9).
5. **removeOnComplete/removeOnFail on every queue; dedicated Redis connections per worker;
   dedicated Redis instance (noeviction, AOF) in compose** (P-08.8, P-08.13;
   `deploy/docker-compose*`).
6. **Real /ready:** forge-api and forge-worker ready-checks ping PG (`SELECT 1` under
   withForgeTx), Redis, and S3 HEAD with 500ms budgets (P-08.14).
7. **Forge itests in CI** (fact-pack S.1): FK-fixed parse upsert, duplicate-delivery
   no-op proofs for verify/extract, outbox drain crash injection, leader-lock overlap test,
   grants/role isolation.

**F2 — the durable spine (months 2–5):**

8. `pipeline_state` transitions wired into every handler transaction; reconciliation sweep
   in maintenance; Redis-wipe drill added to the runbook and CI-adjacent staging test
   (P-08.15, P-08.16).
9. Extraction candidates store + content-hash result cache + durable per-tenant budget
   lease (P-08.2, P-08.5, P-08.10 — model/prompt specifics in doc 04; ClickHouse telemetry
   per fact-pack S.1 F2 when event volume warrants).
10. Retry taxonomy + full jitter + opossum breakers in the shared platform package;
    worker-primitive convergence (P-08.17).
11. Backpressure + per-tenant fairness (app-level round-robin; evaluate BullMQ Pro groups);
    priority lanes live/backfill/redrive.
12. OTel through job payloads (bullmq-otel), forge_* metrics (queue depth, age-of-oldest,
    stage latency, DLQ arrival, budget burn), SigNoz per the observability workstream
    (fact-pack S.2#10).

**F3 — scale & operator tooling (months 5–9):**

13. pg_partman on `pipeline_state` + append-heavy tables; backfill_runs/partitions +
    replay tooling over the R2 archive.
14. Console v2 surfaces: DLQ browse/redrive, quarantine browser, per-record lineage view
    ("where is record X") over pipeline_state (UI contract owned by doc 13; today's console
    has zero of these, fact-pack §5.5).
15. Durable-engine evaluation against the trigger criteria; Hatchet spike if fired.

**API changes:** `GET /bff/pipeline/records/:contentHash` (per-record state timeline),
`GET /bff/dlq` + `POST /v1/dlq/:id/redrive` (data:manage, rate-limited,
idempotency-verified), `GET /bff/quarantine` + `POST /v1/quarantine/:id/reparse` — all RFC
9457, keyset-paginated (platform contract; the console BFF contract mismatches are doc 13's
P-list). **Folder changes:** `packages/worker-platform/` (new), forge-worker locals deleted,
`packages/db/src/repositories/forge/{pipelineState,deadLetters,quarantine}.ts` (new).
**Migrations:** two hand-authored migrations (constraints; state/outbox/lanes) at the next
free indexes (mind the duplicated 0053 index, fact-pack §6.4).

## Migration strategy

1. **Order matters:** schedulers + FK fix + constraints (F1 items 1–3) ship before any
   capture traffic exists — the pipeline is currently dark (flags off), which is precisely
   why this is the cheapest possible moment: there is no live data to migrate and silver is
   empty because every write failed (fact-pack §3.2).
2. **Dual-write window for state:** handlers write `pipeline_state` alongside existing
   behavior behind `FORGE_PIPELINE_STATE_ENABLED`; the reconciliation sweep runs in
   report-only mode for two weeks (drift metrics, no re-enqueue) before enforcement flips.
3. **Outbox cutover:** landEnvelope's direct `.add()` is replaced by outbox+relay behind a
   flag; both paths share the deterministic jobId so a double dispatch during the window is
   a BullMQ no-op.
4. **Queue retirement:** forge-capture-ingest/extract/quality producers never existed;
   delete the Queue constructions and drain/obliterate the empty keys in one deploy.
5. **Redis move:** stand up the dedicated instance, point the fleet at it, and let the
   reconciliation sweep re-enqueue anything pending — the first execution of the exact
   drill the target architecture makes routine.
6. **Rollback:** every step is flag-gated and additive; rollback = flip the flag. The only
   irreversible change is the constraints migration, which is rollback-safe because it can
   only reject writes that would have been duplicates.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| pipeline_state write amplification (one row-update per stage per record) at 25M/day stress | Medium | Medium | Batched transitions per chunk; partitioning; state rows are ref-only (no payloads); fact-pack §7.3 headroom (batched INSERT ~37K rows/s) |
| Reconciliation re-enqueues fight live traffic after an outage | Medium | Medium | Redrive priority lane 8; bounded re-enqueue rate; age-ordered |
| Unique-constraint additions surface latent duplicate rows | Low | Low | Tables are effectively empty today (fact-pack §3.2); pre-migration count checks |
| BullMQ Pro cost/lock-in for fairness | Low | Low | App-level round-robin first; Pro is an optimization, not a dependency |
| Convergence on worker-platform destabilizes main-app workers | Medium | High | Extract from apps/workers verbatim (it is the proven copy); forge adopts first; main app switches only after a full release cycle |
| Scheduler bugs create duplicate sweeps across replicas | Low | Medium | Heartbeat leader lock + idempotent sweep bodies + overlap itest (F1 item 7) |

## Success metrics

- **Outbox drains:** `outbox_oldest_pending_seconds` < 300 p95 (page > 900) — the plan's
  own paging SLI (fact-pack §2.1 observability), currently unmeasurable and infinite.
- **Freshness SLOs:** 95% of captures parsed ≤ 5 min, extraction candidates ≤ 15 min,
  review-ready ≤ 30 min; alert on burn rate > 5× for 10 min (fact-pack §10.8).
- **Effectively-once proven:** duplicate-delivery test suite (retry-storm injection)
  produces 0 duplicate review tasks, 0 double Anthropic bills, 0 double metering rows
  (CI-gated; directly falsifies P-08.4/P-08.5).
- **Recovery:** Redis-flush drill recovers 100% of pending records from pipeline_state with
  zero manual steps; deploy drain drops 0 jobs (staging chaos test).
- **Failure lanes:** DLQ rate < 0.5% of jobs/day steady-state; 100% of DLQ + quarantine
  entries browsable and redrivable from the console; quarantine triage ≤ 48h.
- **Bounded Redis:** steady-state Redis memory flat week-over-week (removeOn* effective);
  maxmemory-policy verified noeviction in deploy preflight.
- **Cost ceiling:** ai-extract spend enforced by durable lease at the configured
  per-tenant/day budget; unbudgeted overrun = 0 (the fleet's two hard ceilings are spend
  and review — fact-pack §2.1).

## Effort & priority

P0 by the priority scale: the pipeline cannot produce data (P-08.1/2/3 are hard blockers for
any ingestion volume) and its failure modes destroy work invisibly (P-08.4–P-08.9). The
14–18 eng-week estimate for the 2–3-engineer pod: F1 correctness (schedulers, FK,
constraints, lanes, Redis hygiene, itests) ~5–6 wks; F2 spine (state table, outbox
everywhere, candidates/budget, taxonomy/breakers, convergence, fairness, OTel) ~7–9 wks; F3
pipeline share (partitioning, backfills, console redrive surfaces) ~2–3 wks alongside the
console and search workstreams. Phase 0 of the hardening (removeOn*, dedicated Redis,
breakers, metrics) is deliberately front-loaded into the first two weeks per fact-pack
§10.9.

## Future enhancements

- Hatchet (or DBOS) adoption when the trigger criteria fire — the verify/HITL DAG and
  fork/resume backfills are the expected first causes (fact-pack §10.3, S.1 F3).
- CDC fan-out (Sequin/pgstream) when a second independent consumer of pipeline events
  appears — search indexing is the likely first (fact-pack §7.6, S.1 F3; doc 11 owns the
  sync seam's evolution to the dormant HTTP path).
- KEDA-style queue-depth autoscale once the fleet leaves the single VM (the plan's doc 16
  intent; deploy reality is FIXED decision #10).
- Saga/compensation formalization for the few truly irreversible flows (merge approval,
  suppression) — forward recovery + reconciliation covers everything else
  (fact-pack §10.6).
- ClickHouse pipeline-telemetry offload when event tables pass 100–200M rows
  (fact-pack §7.4, S.1 F2/F3).
