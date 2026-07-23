# 14 — Performance & Scaling

> **Priority:** P1 · **Effort:** 14–20 eng-weeks (≈3–4 F1 · 8–11 F3 · 3–5 F4) · **Phase:** F1 → F3 → F4
> (phases are defined in 17-phased-implementation-roadmap.md)

## Executive summary

This document owns the volume model, the bottleneck inventory, and the scale-out path for
Forge: the load the platform is contracted to carry (planning doc 17's model: 2.5M raw
captures/day at baseline rising to 25M/day under stress, ~350→3,500 rps peak ingest, a golden
dataset growing 15M→50M+ persons in 18–24 months, 100M+ raw rows retained — fact pack
§2.1/§2.5), what breaks first in the code as-built, and the ordered playbook to reach that load
without re-platforming. Three findings dominate. First, the ingest write path is architecturally
incapable of its own <300ms-p95 ack SLO: envelope landing runs O(records) **sequentially inside
one Postgres transaction**, and each large record's S3 PUT executes **inside that open
transaction** — a maximum envelope holds a pooled `leadwolf_forge` connection across up to
~10,000 S3 round-trips while the whole request body sits buffered in memory up to Bun's 128 MB
default (fact pack §3.3, §4.1; `apps/forge-api/src/server.ts:54-57`,
`packages/forge-core/src/ingest.ts:96-97`). Second, every shared resource is unbounded or
single-pointed: all nine queues ride one shared IORedis connection, no forge queue sets
`removeOnComplete`/`removeOnFail` so Redis grows without bound (P-01.17), the BFF overview
issues four unbounded `COUNT(*)` over append-only tables with no cache or rate limit, and no
table is partitioned against a ~900M-row/year baseline write rate. Third, scale is ultimately
bounded by **two ceilings no infrastructure buys back** — ai-extract spend and the human-review
queue — so the highest-leverage "performance" work is deterministic-first extraction and
confidence-routed auto-approval, not database tuning. The headline recommendation: batch the
land path (S3 before the transaction, staged COPY-style writes, capped batch transactions) and
bound every pool in **F1** while capture is still dark; partition, add read replicas and
precomputed rollups, and install backpressure with per-tenant fairness in **F3**; adopt
Citus/ClickHouse/OpenSearch only at named triggers in **F4**. Postgres remains the system of
record throughout — the OpenAI pattern (one primary + ~50 read replicas serving 800M users) and
the COPY envelope (~63K rows/s) put every target in this model inside a disciplined
single-primary design (fact pack §7.3). Pipeline mechanics are owned by
08-pipeline-architecture.md, storage economics by 09-storage-strategy.md, the ER engine by
05-entity-resolution.md, search by 10-search-indexing.md, and the spend program by
15-cost-optimization.md; this document sets the load contract and the scaling triggers they all
build against.

## Current state

### Capacity baseline

Forge runs on the platform's single-VM Docker Compose deployment behind Caddy (fact pack §0),
as three services off the shared `leadwolf:latest` image — forge-api :3005, forge-worker
(health :3006), console :3004 — **with no CPU or memory limits or reservations**, in contrast
to the main api/auth services which have them (fact pack §4.4). Every service connects with the
same owner DSN and reaches `leadwolf_forge` only via `SET LOCAL ROLE` per transaction
(`packages/db/src/client.ts:70-75`, fact pack §6.4). Live volume today is **zero**: capture is
dark behind `FORGE_CAPTURE_ENABLED` plus a per-tenant allowlist (fact pack §4.1), and sync
never drains because nothing schedules it (P-01.4). Everything below describes what happens on
the day the flags flip.

### The write path as-built

`POST /v1/captures` lands the entire envelope per-record inside **one** `withForgeTx`
(`apps/forge-api/src/server.ts:54-57`; fact pack §3.3). For each record sequentially: payloads
above the 8 KB threshold are PUT to S3 **inside the open transaction**
(`packages/forge-core/src/ingest.ts:96-97`), the row is inserted with
`ON CONFLICT (content_hash) DO NOTHING` against a **globally unique** hash
(`packages/db/src/migrations/0070_forge_schema.sql:28`), and the parse job is enqueued
mid-transaction, before commit (`ingest.ts:131` — the P-01.7 race). The HTTP caps — 20 MB per
envelope, 5 MB per record — are enforced against **client-declared** `envelope.size` /
`record.byteSize`, never measured (`apps/forge-api/src/features/captures/routes.ts:49-54`,
P-01.13); the v2 envelope contract admits up to ~10,000 records per envelope, and the actual
body ceiling is Bun's default 128 MB because no body-size middleware exists (fact pack §4.1).
The whole body is buffered in memory before processing. Rate limiting exists only on captures:
a Redis fixed window per **callerId** (user, not tenant) of 2,000 records + 64 MB/min that
fails open on Redis error, with non-atomic INCR/EXPIRE (fact pack §4.1).

### Queue and worker topology

forge-worker creates nine queues on **one shared IORedis connection**
(`forge-{capture-ingest,parse,ai-extract,extract,resolve,verify,quality,sync,maintenance}`),
three of which are dead; worker concurrency is parse 8, ai-extract 4, resolve 2, verify 4,
maintenance 1, plus sync 4 behind `FORGE_SYNC_EGRESS_ENABLED` (fact pack §4.2). **No forge
queue sets `removeOnComplete` or `removeOnFail`** — the platform's own queues set both — so
completed and failed jobs accumulate in Redis indefinitely (fact pack §4.2, P-01.17). The DLQ
is a `console.error` at exhaustion (`apps/forge-worker/src/register.ts:77-86`). There is no
producer or repeatable job for `forge-sync` or `forge-maintenance` anywhere in the repo (fact
pack §4.2). Stage deadlines are enforced by a `withDeadline` race that does not cancel the
orphaned work, and the maintenance leader lock TTL (60s) is shorter than the 120s processor
deadline, so leadership can lapse mid-run (fact pack §4.2). The planned priority lanes
(live=1, backfill=5, DLQ-replay=8) and the planned ai-extract concurrency pin of 1 pending an
atomic budget lease are not built — ai-extract runs at concurrency 4 against an in-memory,
per-process budget store (fact pack §2.1, §4.2; `apps/forge-worker/src/processors.ts:103`,
P-01.21).

### The read path

`GET /bff/overview` computes four totals `{captured, parsed, verified, synced}` as unbounded
`COUNT(*)`-shaped aggregates over the four layer tables via
`packages/db/src/repositories/forge/readRepository.ts` under `withForgeTx` (fact pack §5.2,
§5.3). There is no cache, no rate limit on any BFF route (fact pack §4.1), the console's auth
gate itself performs this same full read as its staff probe
(`apps/forge/src/lib/forgeGate.ts:14-24`), and the landing page then fetches it again — two
full-table aggregate passes per console visit (fact pack §5.4, §5.5). `listParsers` is
unbounded (`readRepository.ts:131-144`), the review list is silently capped at 50
(`readRepository.ts:108`), and no console surface paginates (fact pack §5.4) — despite cursor
pagination being a fixed platform contract.

### Storage and drain

Migration 0070 creates 15 **plain (unpartitioned) tables**; the planning suite specified
monthly RANGE partitioning (fact pack §1). Raw payloads ≤8 KB live inline as `text` in
Postgres; larger ones go to S3, routed by the client-declared size (`ingest.ts:94`). The
volume model prices bronze at ~5 GB/day into Postgres plus ~31 GB/day of blobs at baseline
(fact pack §2.1). The sync drain, when it ever runs, takes batches of 50 with
`FOR UPDATE SKIP LOCKED`, **no ORDER BY**, across three separate transactions, then applies
per-row under `withErTx` (fact pack §3.3). `review_tasks` is an unbounded open queue — rows
are inserted and never claimed, resolved, or closed (fact pack §3.2).

### What the planning suite intends (intent, not reality)

Planning doc 17 commits to the volume model this document adopts, and flags it **uncalibrated**
(fact pack §2.1). Doc 16 specifies KEDA queue-depth autoscaling, Aurora Serverless v2 + RDS
Proxy (with the unresolved G-FORGE-1602 incompatibility), and blue/green deploys (fact pack
§2.1). The NFRs: ingest ack <300ms p95, 99.99% ingest/sync availability, raw 100M+ rows,
ER blocking at 0.05–1% of the cartesian product (fact pack §2.5). Meanwhile `forge-core` ships
`capacity.ts` sizing arithmetic, a `desiredWorkers` autoscale calculator, and `DEFAULT_SLOS` —
all with **zero production callers** (fact pack §3.1) — and `/metrics` emits two static gauges
with no queue depth, latency, or failure series (fact pack §4.4).

## Problems identified

Ordered by severity. **BUG** = wrong today · **GAP** = missing capability · **DEBT** = works,
won't scale · **RISK** = exposure.

- **P-14.1 — DEBT (P0-grade) · Envelope landing is O(records) sequential inside one Postgres
  transaction, with S3 PUTs inside the open transaction.** A maximum envelope (~10,000 records,
  many >8 KB) holds one pooled `leadwolf_forge` connection open across up to ~10K sequential S3
  round-trips — minutes of wall time per envelope (`server.ts:54-57`, `ingest.ts:96-97`; fact
  pack §3.3). At the baseline peak of ~350 rps this exhausts any plausible pool within seconds;
  worse, minutes-long transactions pin the xmin horizon so autovacuum cannot reclaim dead
  tuples anywhere in the database, and one S3 latency spike or failure rolls back the entire
  envelope. The <300ms-p95 ack NFR (fact pack §2.5) is unattainable by construction. This is
  the single hardest blocker for any real ingestion volume.
- **P-14.2 — DEBT · The whole request body is buffered in memory up to Bun's 128 MB default.**
  No body-size middleware exists and the declared 20 MB cap is never checked against measured
  bytes (fact pack §4.1, P-01.13). Ten concurrent stress-tier envelopes can spike >1 GB RSS in
  a process with no compose memory limit on a shared single VM (fact pack §4.4) — the failure
  mode is the OOM killer taking forge-api (or a neighbor) down.
- **P-14.3 — DEBT · One shared Redis connection for all nine queues.** Every producer command
  serializes on a single socket and shares one failure domain (fact pack §4.2); BullMQ's own
  guidance requires dedicated blocking connections per consumer and warns that CPU starvation
  of the event loop blocks lock renewal and manufactures stalled jobs (fact pack §10.2) — a
  real hazard with parse/AI work co-located at concurrency 8+4 in the same process.
- **P-14.4 — DEBT · The BFF overview is four unbounded COUNT(*) over growing tables, uncached
  and unrate-limited, executed twice per console visit.** At the NFR scale of 100M+ raw rows,
  each aggregate is an O(table) scan measured in tens of seconds; four of them, doubled by the
  gate probe (`forgeGate.ts:14-24`; fact pack §5.3–§5.5, §4.1), turn every dashboard load into
  minutes of primary DB time and pinned connections. A handful of operators can degrade the
  ingest path — a self-inflicted denial of service with no attacker required.
- **P-14.5 — DEBT · Redis grows without bound.** No `removeOnComplete`/`removeOnFail` on any
  forge queue (P-01.17; fact pack §4.2). The #1 BullMQ outage class is exactly this (a reported
  10 GB from 4.5M retained jobs, fact pack §10.2); at 2.5M+ jobs/day the shared Redis fails in
  days, and because `jobId = contentHash` dedups re-enqueue, retained completed jobs also
  permanently block re-capture (interacts with P-01.7).
- **P-14.6 — GAP · No partitioning on append-heavy tables.** `raw_captures`, `parsed_records`,
  `extraction_runs`, `verified_record_events`, `sync_outbox`, `forge_audit_log`, and
  `review_tasks` are plain tables (0070) facing ~900M rows/year at baseline. Without RANGE
  partitions there is no cheap retention (`DELETE` instead of `DROP PARTITION`), vacuum and
  index maintenance degrade continuously, and the planned monthly partitioning (fact pack §1)
  exists only on paper. Retrofitting at 100M rows is a rewrite; doing it now is trivial.
- **P-14.7 — GAP · No backpressure and no per-tenant fairness anywhere.** The only throttle is
  the per-user fixed window at the capture edge, and it fails open (fact pack §4.1). Nothing
  pauses intake on queue depth or age, nothing sheds low-priority work, and the planned
  priority lanes are unbuilt (fact pack §2.1) — one tenant's backfill starves every tenant's
  live captures, and a downstream stall (Anthropic, S3, Postgres) turns into unbounded queue
  growth instead of a controlled slowdown.
- **P-14.8 — DEBT · Connection-pool posture is unbounded and undifferentiated.** All forge
  processes share the owner DSN with `SET LOCAL ROLE` (fact pack §6.4); there is no PgBouncer
  or per-service pool budget, and forge-api adds a per-request owner-connection
  `platform_staff` lookup to every BFF call (fact pack §4.1, §6.4). Under load, ingest, BFF
  aggregates, and staff lookups compete for the same undifferentiated connections — the fixed
  platform decision is *bounded* pools, and Forge has none.
- **P-14.9 — DEBT · The sync drain shape cannot honor ordering or throughput at target.**
  Batch-50 with no `ORDER BY` across three separate transactions, then one `withErTx`
  round-trip per row (fact pack §3.3). At 1.2M promotions/day (~14/s) this needs a scheduler
  that does not exist (P-01.4) plus ordered, batched apply; unordered drain also risks
  applying `verified.superseded` before its predecessor (fact pack §6.1).
- **P-14.10 — DEBT · Raw payloads live in Postgres row storage.** Inline `text` up to 8 KB per
  record and ~5 GB/day of bronze growth (fact pack §2.1) sit directly on the TOAST cliff —
  values over ~2 KB TOAST out-of-line with 2–10× read penalties and full-blob rewrites on
  update (fact pack §7.3). Bloats backups and vacuum for data that is write-once. The move to
  object storage is owned by 09-storage-strategy.md; this document depends on it.
- **P-14.11 — GAP · No saturation signals exist.** `/metrics` is static (fact pack §4.4): no
  queue depth, no age-of-oldest, no stage latency, no DLQ rate — the canonical staleness
  signal is age-of-oldest (fact pack §10.8) and it is not measured. Backpressure (P-14.7) and
  autoscaling are unbuildable until this lands; the metrics catalog is owned by
  12-observability.md.
- **P-14.12 — RISK · Unbounded co-located workers on a shared VM, with ai-extract at
  concurrency 4 against a non-durable budget.** No compose limits (fact pack §4.4) means a
  parse burst can starve the API and Caddy of CPU; ai-extract at 4 with an in-memory,
  per-process budget keyed per-capture (P-01.21) means the spend ceiling — one of the two hard
  ceilings — is enforced nowhere under exactly the load where it matters.
- **P-14.13 — GAP · The ER blocking budget is unimplementable today and mis-specified for
  100M.** Silver `block_key`/`email_blind_index` are always NULL (P-01.3), so no blocking is
  possible at all; and the 0.05–1%-of-cartesian NFR (fact pack §2.5) is the wrong unit at
  scale — 0.05% of (100M)² is still 5×10¹² comparisons. The workable budget is a per-record
  candidate cap (<50 candidates/record, block-size caps — fact pack §8.6), owned by
  05-entity-resolution.md; this document sets the ceiling.
- **P-14.14 — GAP · No read/write separation.** Every read — BFF aggregates, review lists,
  future analytics — lands on the primary that must also absorb the write load. The fix
  (replicas + rollups) is sequenced below; the single-VM deploy reality (fact pack §0) makes
  this an F3 infrastructure item, not a config flag.

## Research findings

### The volume model (planning doc 17, adopted as the contract)

The suite's scale model (fact pack §2.1, §2.5 — flagged **uncalibrated** by its own authors):
raw captures 2.5M/day baseline → 25M/day stress (~350 → ~3,500 rps peak); ~500K distinct
profiles/day at ~4 captures each; payload p50 6 KB / p99 120 KB / cap 1 MB; AI extraction on
~10% of parsed records (0.5M → 5M calls/day); verified UPSERTs ~1.2M/day (dedup ~4:1); human
review 5–15K items/day — an explicitly human ceiling, target ≤1% of flow; golden dataset
15M → 50M+ persons within 18–24 months; bronze growth ~5 GB/day Postgres + ~31 GB/day blobs.
NFRs: raw 100M+ rows retained; blocking 0.05–1% of cartesian; ingest ack <300ms p95; 99.99%
ingest/sync availability; capture throttle 2,000 rec/min/caller (fact pack §2.5).

### Postgres at scale

- OpenAI runs 800M users at millions of QPS on **one Postgres primary plus ~50 read
  replicas** — the discipline is offloading reads and keeping the primary lean; single-node
  envelopes of billions of rows / single-digit TB are routine, and "97% of problems are
  indexing and vacuuming" (fact pack §7.3; Bohan Zhang, "Scaling Postgres to the next level,"
  PGConf.dev 2025 — talk URL not re-verified).
- Write throughput ladder: single-row INSERT ~2.3K rows/s, batched ~37K, COPY ~63K (pgx
  CopyFrom ~357K at 50K-row batches) (fact pack §7.3;
  https://www.postgresql.org/docs/current/sql-copy.html). Millions of pipeline rows/day are
  trivial **if batched** — the current per-record path forfeits ~30× for free.
- Declarative partitioning requires that unique constraints on a partitioned table include the
  partition key (https://www.postgresql.org/docs/current/ddl-partitioning.html) — directly
  load-bearing here, because `raw_captures.content_hash` and `verified_records.content_hash`
  are globally unique. pg_partman automates partition lifecycle
  (https://github.com/pgpartman/pg_partman); PgBouncer transaction pooling is the standard
  bounded-pool front (https://www.pgbouncer.org/features.html).
- JSONB/text over ~2 KB TOASTs out-of-line: compressed reads ~2× slower, external ~5×, worst
  ~10×, and every update rewrites the whole blob (fact pack §7.3;
  https://www.postgresql.org/docs/current/storage-toast.html).
- Citus 13 (Feb 2025) is 100% open source on PG17 with schema-based sharding
  (https://github.com/citusdata/citus) — the designated scale-out when a tuned, partitioned,
  replica-offloaded primary still write-saturates (fact pack §7.3, §7.8).
- SKIP LOCKED queues hit lock-scan and MVCC-bloat ceilings under hundreds of pollers;
  mitigations are aggressive autovacuum, partition-and-drop, and partial indexes; DBOS pushed
  a tuned Postgres queue from 100/s to 30K/s (fact pack §10.4).

### Queue envelope (BullMQ)

Benchmarks put BullMQ at ~15K adds/s per queue and ~50K jobs/min processed on one Redis; 10M
jobs/day is ~115/s average — an order of magnitude below the ceiling (fact pack §7.6, §10.2).
The #1 outage class is Redis memory growth from missing `removeOnComplete`/`removeOnFail`
(https://docs.bullmq.io/guide/queues/auto-removal-of-jobs), `maxmemory-policy noeviction` is
mandatory because eviction silently corrupts queues
(https://docs.bullmq.io/guide/going-to-production), and connection guidance requires dedicated
blocking connections per worker (https://docs.bullmq.io/guide/connections). BullMQ Pro adds
groups — per-tenant fairness — at ~$95/mo intro (fact pack §10.2). Retry discipline is
exponential backoff with full jitter
(https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/). Verdict from the
research pass: **keep BullMQ**; demote Redis to a replaceable transport with Postgres as the
pipeline's source of truth (fact pack §7.6, §10.9; mechanics in 08-pipeline-architecture.md).

### ER blocking envelope

Splink v4 dedupes 9M rows in ~45 min on 96 cores and 80M in <2h; its Postgres backend is
experimental, so weights are trained offline in a DuckDB sidecar
(https://moj-analytical-services.github.io/splink/; fact pack §2.5, §8.1). Production blocking
at 100M+ is multiple cheap deterministic keys with block-size caps and <50 candidates per
record; Apollo confirms union-find with Redis locks in production and attributes ~90% of its
duplicate accounts to ingestion without a resolution gate
(https://www.apollo.io/tech-blog/detecting-data-duplication-at-scale; fact pack §8.1, §8.5,
§8.6).

### Read-path and analytics offload

Postgres facet-style `GROUP BY` counts take seconds at 10M+ rows and are unusable at 100M
without rollups; GIN indexes suffer update amplification under enrichment-write load
(https://pganalyze.com/blog/gin-index; fact pack §11.1). ParadeDB's vendor benchmark puts BM25
ranking at 6.28ms on 28M rows (https://paradedb.com/blog/elasticsearch-vs-postgres — facet
maturity contested; validate). ClickHouse as a second, non-authoritative database absorbs
event/telemetry analytics with 10–20× compression at ~$200–400/mo single-node; PG→CH CDC is
solved by PeerDB (acquired by ClickHouse, July 2024, still free OSS) (fact pack §7.4). The
trigger: event tables >100–200M rows or telemetry measurably hurting OLTP — "arguably now" for
pipeline telemetry (fact pack §7.4; details in 09-storage-strategy.md). Cloudflare R2's zero
egress makes reprocessing and backfills free at $15/TB-mo
(https://developers.cloudflare.com/r2/pricing/; fact pack §7.5).

### AI and human ceilings

Anthropic Batch API is a flat 50% discount and stacks with prompt caching (fact pack §11.2,
verified against platform.claude.com 2026-07-22); blended extraction cost with a
deterministic layer handling 60–80% of records lands at $500–1,500 per 1M records, and a
content-hash result cache makes re-captures $0 (fact pack §11.2; full cost program in
15-cost-optimization.md). HITL practice is confidence-routed queues with auto-accept starting
at ~85–90% calibrated, plus 0.5–2% stratified QA sampling (fact pack §11.2).

## Enterprise best practices

What a ZoomInfo/Apollo/LinkedIn-class platform does for this concern:

1. **Batch-first writes.** Bulk lanes never do row-at-a-time inserts or one queue job per row:
   COPY into staging, set-based merge, 1–10K-row chunks per job, per-row status in the
   database (fact pack §10.7). External I/O (object storage, providers) never runs inside a
   database transaction.
2. **Partition lifecycle from day one on append-heavy tables** — retention is `DROP
   PARTITION`, vacuum stays local, and indexes stay shallow. Retrofitting is a migration
   project; starting partitioned is a migration line.
3. **Dashboards never aggregate OLTP.** Counters are precomputed rollups maintained
   incrementally (or served from an OLAP store); the serving query is an indexed point read.
4. **Pool discipline everywhere:** a transaction pooler in front of Postgres, explicit
   per-service pool budgets, and separate read routing so analytics cannot starve ingest.
5. **Autoscale and alert on age-of-oldest and burn rate, not CPU or raw depth** (fact pack
   §10.8) — freshness SLOs per stage ("95% of records parsed within N min") are the product
   metric.
6. **Fairness is a product requirement:** per-tenant concurrency shares and priority lanes so
   one tenant's backfill cannot move another tenant's p95.
7. **The expensive stages are budgeted, not just scaled.** AI spend and human review get
   explicit ceilings, routing rules that shrink their share of flow, and dashboards that show
   the ceiling's headroom — Apollo/ZoomInfo scale contributor networks and researcher teams
   only where the model says the marginal record is worth it (fact pack §2.5, §8.5).
8. **Load tests are pinned to the volume model and run in CI** before any capacity-affecting
   change; the capacity model is a living document re-baselined quarterly against production
   telemetry.

## Recommended architecture

### The volume model as the contract

All sizing below serves this table (baseline and 10× from planning doc 17, fact pack §2.1/§2.5;
2× is linear interpolation; averages derived):

| Metric | Baseline | 2× | 10× (stress) |
|---|---|---|---|
| Raw captures/day | 2.5M | 5M | 25M |
| Ingest, avg / peak rps | ~29 / ~350 | ~58 / ~700 | ~290 / ~3,500 |
| Distinct profiles/day (~4 captures each) | ~500K | ~1M | ~5M |
| Payload size p50 / p99 / cap | 6 KB / 120 KB / 1 MB | — | — |
| AI-extract calls/day (~10% of parsed) | 0.5M (~6/s) | 1M | 5M (~58/s) |
| Verified UPSERTs/day (dedup ~4:1) | 1.2M (~14/s) | 2.4M | 12M (~139/s) |
| Human review items/day | 5–15K (**fixed ceiling**) | 5–15K | 5–15K |
| Pipeline jobs/day (all stages) | ~10M (~115/s avg) | ~20M | ~80–100M (~1,000+/s avg) |
| Bronze growth | ~5 GB/day PG + ~31 GB/day blobs | 2× | 10× |
| Golden dataset | 15M persons | → | 50M+ persons (18–24 mo) |
| Retained raw rows (NFR) | 100M+ | — | — |
| Ack latency (NFR) | <300ms p95 | same | same |
| Ingest/sync availability (NFR) | 99.99% | same | same |

Two calibration notes. First, the suite itself flags the model uncalibrated (fact pack §2.1) —
success metric #8 below makes calibration a gate. Second, at 10× the *job count* (~1,000/s
avg) exceeds the measured single-Redis processing envelope (~50K jobs/min ≈ 833/s, fact pack
§7.6) if every record remains one job per stage — which is why the playbook below batches bulk
lanes (1–10K records/job) and slims payloads to IDs, cutting job counts 100× where it matters
(fact pack §10.7).

### The two hard ceilings and their design responses

**Ceiling 1 — ai-extract spend.** 0.5M→5M calls/day is the only stage whose marginal cost is
cash. Response (owned by 11-ai-assisted-processing.md and 15-cost-optimization.md, required by
this document): **deterministic-first** — versioned JSONPath/Zod mappers take 60–80%+ of
parsed records so the AI share shrinks from ~10% toward ~5%; Batch API (50% off) for
everything not latency-sensitive; prompt caching; a **content-hash result cache** so
re-captures of the same payload cost $0 (dedup is ~4:1 — the cache alone removes most repeat
spend); and a **durable per-tenant/day budget** (Redis/PG, not in-memory — replacing P-01.21)
enforced with an atomic lease before concurrency ever rises above 1 (fact pack S.2#6, §11.2,
§2.1).

**Ceiling 2 — the human-review queue.** 5–15K items/day is a staffing constant, not a scaling
variable: at baseline's 1.2M verified UPSERTs/day, even 1% routed to humans (12K) consumes the
entire ceiling — at 10× it is 0.1%. Response: **confidence routing with auto-approve** —
calibrated auto-accept starting ≥85–90% confidence, review only the uncertain band, 0.5–2%
stratified QA sampling with honeypots for reviewer quality (fact pack §11.2, §2.1); a
**depth-bounded queue** that sheds to a deferred lane instead of growing unboundedly
(replacing the never-closed `review_tasks` pile, fact pack §3.2); and ranked ordering
(confidence × value × freshness × risk, fact pack §2.1) so the ceiling is spent on the highest
expected value. The review SLA and four-eyes mechanics stay with 05-entity-resolution.md and
doc 01's P-01.10 remediation.

### The per-tier scaling playbook

**Tier 1 — Ingest/land (F1).** Invert the transaction: *validate → measure → hash → PUT to
object storage → then one short batch transaction*. Stream the request body against a hard
measured cap (reject at 20 MB read, not declared); recompute `content_hash` server-side
(P-01.12); PUT large payloads to S3/R2 **before** opening the transaction — content-addressed
writes are idempotent and safe to orphan; then land the batch with a staged COPY-style write
(`COPY`/multi-row insert into `forge.land_staging`, one set-based
`INSERT … ON CONFLICT` into `raw_captures`, outbox rows same-tx) capped at ~1,000 records or
~10 MB per transaction, chunking larger envelopes into multiple short transactions with
per-record status. Enqueue after commit via the outbox relay (08-pipeline-architecture.md;
fixes P-01.7 as a side effect). The COPY envelope (~63K rows/s) makes the 3,500 rps stress
peak ~5% of single-node write capacity.

**Tier 2 — Queues (F1 hardening, F3 fairness).** Dedicated Redis connections per blocking
consumer and a bounded producer pool (P-14.3); `removeOnComplete: {age, count}` /
`removeOnFail` on every queue (P-14.5); dedicated Redis instance with
`maxmemory-policy noeviction` + AOF everysec; job payloads carry IDs only (<1 KB), never
payloads; priority lanes live=1 / backfill=5 / DLQ-replay=8 (fact pack §2.1); per-tenant
fairness via BullMQ Pro groups or app-level per-tenant round-robin (decision in
08-pipeline-architecture.md); batch jobs (1–10K records) for backfill/bulk lanes.

**Tier 3 — Database write path (F1 pools, F3 partitioning).** PgBouncer transaction pooling in
front of Postgres with explicit per-service pool budgets (forge-api small, forge-worker sized
to concurrency, BFF isolated); pg_partman monthly RANGE partitions on the seven append-heavy
tables; global dedup moves to a slim unpartitioned claims table because a partitioned
`raw_captures` cannot carry a global `content_hash` unique constraint (PG limitation — see
Implementation details; this aligns with 03-data-ingestion-architecture.md's split of global
content storage from per-tenant capture claims); raw payload bodies leave Postgres for the R2
archive per 09-storage-strategy.md (P-14.10); hot JSONB fields promoted to columns (fact pack
§7.3).

**Tier 4 — Reads (F1 stopgap, F3 structure).** F1: rate-limit and cache (15–30s TTL) the BFF
aggregates, and stop the double-fetch by giving the gate a cheap `/bff/me` (doc 01, P-01.25).
F3: replace counts with **precomputed rollups** (`forge.stat_rollups`, incremented by the
maintenance/aggregation job from pipeline-state deltas) so the overview is an indexed point
read; add a **read replica** and route BFF/analytics reads to it; pipeline telemetry and
event-grain analytics move to single-node ClickHouse at the stated trigger
(09-storage-strategy.md; fact pack §7.4). Cursor pagination on every list surface (fixed
platform contract; fact pack §5.4 shows none today).

**Tier 5 — ER blocking budget at 100M (F2 engine, F3 scale).** The engine is
05-entity-resolution.md's; this document fixes its budget: blocking keys populated at silver
(unblocks P-01.3/P-14.13), multiple cheap deterministic keys, **block-size caps and a <50
candidates/record ceiling** (fact pack §8.6) — the workable unit at 100M, where even 0.05% of
the cartesian product is 5×10¹² comparisons; incremental resolution re-clusters only touched
components; full-corpus backfills and weight training run **offline in Splink/DuckDB** (9M/45
min/96 cores; 80M <2h — fact pack §8.1), never on the OLTP primary.

**Tier 6 — Search (F3→F4).** Owned by 10-search-indexing.md: engineered Postgres (tsvector +
trgm + facet rollup tables, ceiling ~10M) → ParadeDB BM25 in-PG at ranking pain or 10M+ →
self-hosted OpenSearch at 30–50M+, fed by outbox/CDC, never dual-writes (fact pack §11.1).
The performance rule this document adds: facet counts always come from rollups or the search
engine, never from OLTP `GROUP BY`.

**Backpressure (F3).** Watermark valves per stage: when `depth(stage) > high` or
`age_of_oldest(stage) > 5× freshness SLO`, pause the upstream producer (intake responds 429 +
`Retry-After` at the edge; internal stages pause their feeder queues), resume at the low
watermark; shed lowest-priority lanes first (fact pack §10.6, §10.8). Precondition: the
metrics exist (P-14.11, with 12-observability.md) and the capture SDK treats 429/5xx as
retryable — today the extension deletes its durable copy on rejection (fact pack §6.3), so
valves must not be enabled before 03-data-ingestion-architecture.md's SDK lands.

### Stage-by-stage targets

| Stage | Throughput (baseline avg → stress peak) | Latency target |
|---|---|---|
| Ingest ack (`POST /v1/captures`) | 29/s → 3,500/s peak | p95 <300ms, p99 <800ms |
| Land (bronze committed) | ≥1,000 rec/s per node (batched) | batch tx <2s p95; no tx >5s ever |
| Parse | 29/s → 290/s avg | 95% parsed within 5 min of land |
| AI extract (live lane) | ~6/s → ~58/s | 95% within 15 min; batch lane <24h |
| Resolve (ER incremental) | 29/s → 290/s | 95% within 10 min; <50 candidates/record |
| Verify → review-ready | human-gated | auto-approve path: 95% e2e within 30 min |
| Outbox → master apply | 14/s avg; ≥50/s drain capacity | outbox oldest-pending p99 <60s |
| BFF overview | any | p95 <200ms (rollup point read) |
| Search (phase 1) | per 10-search-indexing.md | p95 <500ms at 10M records |

### Scale-out triggers (do not act early; do not miss them)

| Trigger | Signal | Action | Phase |
|---|---|---|---|
| Telemetry/event tables >100–200M rows, or OLTP p95 degraded by analytics | table sizes, query-time attribution | Single-node ClickHouse + PeerDB CDC (09-storage-strategy.md) | F3 |
| Search ranking pain or corpus >10M | ranking latency, relevance complaints | ParadeDB in-PG (10-search-indexing.md) | F3 |
| Corpus 30–50M+ or facet SLO misses | facet p95, index size | OpenSearch 3-node (10-search-indexing.md) | F4 |
| Raw archive >1–5 TB with multi-writer reprocessing | R2 usage | DuckLake with PG catalog (09-storage-strategy.md) | F4 |
| Primary write-saturated after partitioning + batching + pooling + replicas | sustained write CPU/WAL >70%, vacuum falling behind | **Citus 13** schema-based sharding of `forge` | F4 |
| Redis sustained >~50K jobs/min or CPU-bound | Redis CPU, command latency | dedicated Redis per stage class; shard queues | F4 |
| ≥2 independent event consumers | consumer inventory | Sequin/pgstream on the outbox (08-pipeline-architecture.md) | F3/F4 |
| Sustained 5–10K+ msg/s cross-team streams | — | broker (Redpanda/NATS) — not before | F4+ |

### Target ingest/read path

```text
            capture edge (forge-api)
  stream body ▸ measured hard cap ▸ recompute content_hash
      │
      ├── large payloads ──▶ R2 PUT (content-addressed, BEFORE any tx; orphan-safe)
      ▼
  batch tx (≤1,000 rec / ≤10MB, <2s):
    COPY → forge.land_staging ▸ set-based INSERT..ON CONFLICT → raw_captures (pg_partman monthly)
    + forge.content_claims (global dedup, unpartitioned)
    + outbox rows (same tx)
      │ commit ▸ 202 {batchId, landed, duplicates, rejected[]}
      ▼
  outbox relay ──▶ BullMQ (dedicated conns · removeOn* · noeviction+AOF · lanes 1/5/8 ·
                   per-tenant fairness · ID-only payloads · batch jobs for bulk lanes)
      │   ▲ backpressure: pause producers on depth/age watermark; edge 429 + Retry-After
      ▼
  stage workers (bounded PG pools via PgBouncer · compose CPU/mem limits ·
                 ai-extract behind durable budget lease · offline Splink/DuckDB for ER backfills)

  reads: console/BFF ──▶ read replica ▸ forge.stat_rollups (point reads; never COUNT(*))
         telemetry/events ──▶ ClickHouse (trigger-gated)      analytics never touch the primary
```

## Implementation details

### F1 — bound the system while it is still dark (3–4 eng-weeks)

Dependency-ordered; items 1–3 are one workstream with 03-data-ingestion-architecture.md.

1. **Measured streaming caps.** `apps/forge-api/src/features/captures/routes.ts` — stream and
   count bytes; reject envelopes >20 MB and records >5 MB on *measured* size (closes P-01.13 /
   P-14.2); add a Hono body-limit so nothing approaches Bun's 128 MB default.
2. **Invert the land transaction.** `packages/forge-core/src/ingest.ts` — split `landEnvelope`
   into `prepareRecords` (hash recompute, S3/R2 PUT, no tx) and `landBatch` (short batch tx);
   `apps/forge-api/src/server.ts:54-57` loses the envelope-wide `withForgeTx`. Contract sketch:

   ```ts
   // packages/forge-core/src/ingest.ts
   interface LandBatchResult {
     batchId: string;
     landed: number;
     duplicates: number;
     rejected: Array<{ index: number; reason: string }>;
   }
   // invariant: every payloadRef already durable in object storage before landBatch is called;
   // landBatch = one tx: staging COPY ▸ set-based upsert ▸ outbox rows. ≤1,000 records/tx.
   async function landBatch(records: MeasuredRecord[], deps: LandDeps): Promise<LandBatchResult>;
   ```

3. **Enqueue after commit** via the outbox relay (08-pipeline-architecture.md) — removes the
   mid-tx `queue.add` at `ingest.ts:131` (P-01.7).
4. **Queue hygiene.** `apps/forge-worker/src/register.ts` (and the queue-construction module
   beside it — exact filename not verified): `removeOnComplete: { age: 86_400, count: 10_000 }`
   and `removeOnFail: { age: 7 * 86_400 }` as `defaultJobOptions` on all forge queues; one
   dedicated IORedis connection per Worker, one bounded shared connection for producers;
   `maxmemory-policy noeviction` + AOF on the (dedicated) forge Redis.
5. **Bounded Postgres pools.** `packages/db/src/client.ts` — explicit per-service pool sizes
   surfaced through validated config (`packages/config/src/forge.ts` folded into
   `appEnvSchema`, closing P-01.29 jointly with doc 01's F1 work); PgBouncer container added to
   the deploy compose (the file under `deploy/` that defines the forge services, fact pack
   §4.4 — exact filename not verified).
6. **BFF stopgap.** `packages/db/src/repositories/forge/readRepository.ts` — bound every list
   (cursor pagination per the platform contract), serve overview counts from a 15–30s cache;
   add a rate limit on `/bff/*` in `apps/forge-api/src/app.ts`; implement `/bff/me` so the
   gate probe stops issuing a full aggregate read (with doc 01's P-01.25 work).
7. **Compose resource limits** for forge-api / forge-worker / forge (parity with api/auth,
   fact pack §4.4); pin ai-extract concurrency to 1 until the durable budget lease exists
   (fact pack §2.1, P-01.21).
8. **Saturation metrics.** Queue depth, age-of-oldest, per-stage latency, DLQ rate exported
   from forge-worker (`/metrics`), replacing the static gauges (fact pack §4.4) — catalog and
   wiring owned by 12-observability.md; this is the precondition for F3 backpressure.

### F3 — scale structure (8–11 eng-weeks)

9. **Partitioning migration.** New migrations under `packages/db/src/migrations/` at the next
   free indexes (note the journal already has a duplicate-index quirk at 0053 — verify
   numbering first, fact pack §6.4). Sketch:

   ```sql
   -- 007x_forge_content_claims.sql — global dedup leaves the partitioned table
   create table forge.content_claims (
     content_hash text primary key,
     raw_capture_id uuid not null,
     first_seen_at timestamptz not null default now()
   );
   -- 007y_forge_partitioning.sql — monthly RANGE via pg_partman
   -- new partitioned parent (captured_at partition key), copy/attach existing rows as the
   -- initial historical partition, swap names inside one transaction, then:
   select partman.create_parent(
     p_parent_table => 'forge.raw_captures', p_control => 'captured_at',
     p_interval => '1 month', p_premake => 3);
   ```

   Same treatment for `parsed_records`, `extraction_runs`, `verified_record_events`,
   `sync_outbox` (short retention + partition-drop), `forge_audit_log`, `review_tasks`.
   Uniqueness that cannot include the partition key (global `content_hash`) lives in
   `content_claims`; dedup semantics change accordingly with
   03-data-ingestion-architecture.md's per-tenant claims split.
10. **Rollups.** `007z_forge_stat_rollups.sql`:

    ```sql
    create table forge.stat_rollups (
      metric text not null,          -- captured|parsed|verified|synced|review_open|dlq…
      bucket_start timestamptz not null,
      value bigint not null,
      computed_at timestamptz not null default now(),
      primary key (metric, bucket_start)
    );
    ```

    Maintained incrementally by the (now-scheduled, per doc 01) maintenance job from
    pipeline-state/outbox deltas; new
    `packages/db/src/repositories/forge/statRollupRepository.ts`; `readRepository.ts` overview
    switches to point reads. `GET /bff/overview` response gains `asOf` so staleness is honest.
11. **Read replica routing.** Add a replica (infrastructure move owned by
    09-storage-strategy.md / 16-technology-recommendations.md); `packages/db/src/client.ts`
    gains a read DSN and `withForgeReadTx`; BFF reads and analytics move over; lag alarm at 5s.
12. **Backpressure valves + fairness.** New `apps/forge-worker/src/backpressure.ts`
    (watermarks over the depth/age metrics; pause/resume producers; edge 429 + `Retry-After`);
    priority lanes on enqueue; per-tenant fairness (BullMQ Pro groups or app-level
    interleaving — decision in 08-pipeline-architecture.md). Gated on the capture SDK's retry
    semantics (03-data-ingestion-architecture.md).
13. **Sync drain shape.** Ordered drain (`ORDER BY id`), batched apply inside one `withErTx`
    per batch, supersede/version guard enforced in `forgeSyncRepository.applyItem` (with doc
    01's P-01.20 and fact pack §6.1 gaps).
14. **Load-test harness as a CI gate.** k6 (https://k6.io/) scenarios pinned to the volume
    model (baseline soak, 2× ramp, 10× burst) against a staging stack with synthetic data;
    green 2× run required before any capture flag flips for a real tenant.
15. **ClickHouse telemetry offload** at its trigger, per 09-storage-strategy.md and
    12-observability.md.

### F4 — scale-out at triggers (3–5 eng-weeks initial)

16. **Citus evaluation** against the trigger row above: schema-based sharding of `forge`
    (distribute `raw_captures`/`parsed_records` by a hash of `content_hash`; goldens/identity
    graph likely stay single-node alongside the ER engine — joint design with
    05-entity-resolution.md before any adoption).
17. **Autoscaling** (KEDA-style, https://keda.sh/) on queue depth + age once the platform
    leaves single-VM Compose; until then, `desiredWorkers` (revived from
    `packages/forge-core/src/observability.ts`, currently caller-less — fact pack §3.1) drives
    documented manual scaling.
18. **OpenSearch / DuckLake / broker** strictly per their trigger rows (10-search-indexing.md,
    09-storage-strategy.md, 08-pipeline-architecture.md).

## Migration strategy

- **Do the land-path inversion now, while volume is zero.** Capture is dark (fact pack §2.6
  invariant 6, §4.1), so the F1 rebuild has no live traffic to break — this is the cheapest
  moment the platform will ever have. Still gate it (`FORGE_BATCH_LAND`) and dual-run in
  staging: old path vs new path on identical synthetic envelopes, diffing landed rows,
  claims, and outbox counts before deleting the old path.
- **Partition before volume, not after.** On near-empty tables the parent-swap migration is
  minutes; at 100M rows it is a rewrite project with long locks. Sequence: F3 starts with the
  partition migrations while tables are <10M rows; rehearse the swap on a staging database
  seeded to 100M synthetic rows to time locks and validate `content_claims` dedup semantics
  (a forge itest asserts duplicate/landed counts across the boundary — extending doc 01's F1
  itest suite).
- **Rollups cut over by dual-read.** Maintain rollups alongside live counts in staging;
  compare for a week; switch `readRepository.ts` to rollups behind a flag; keep the raw-count
  path available (rate-limited) for reconciliation.
- **Replica routing cuts over per-route.** Move `/bff/overview` first (staleness-tolerant),
  review lists last; pin any read-after-write path to the primary; alarm on lag >5s before
  widening.
- **Backpressure arms in shadow.** Valves log intended pauses for two weeks before enforcing;
  enforcement only after the capture SDK's retry/backoff semantics ship
  (03-data-ingestion-architecture.md) — today's client deletes data on rejection (fact pack
  §6.3).
- **Rollback:** every valve, rollup, and routing change is flag-gated with the previous path
  intact for one phase; the partition swap is the one hard-to-reverse step — mitigated by the
  rehearsal, a pre-swap snapshot, and running it inside a maintenance window while ingest is
  paused (or still dark).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Partition retrofit deferred until tables hold 100M+ rows (missed window) | Medium | High — long-lock rewrite under load | Schedule migrations at F3 start while tables are small; 100M-row staging rehearsal; success metric #5 |
| Global `content_hash` uniqueness vs partition key (PG limitation) discovered late | Certain (it is a documented limitation) | High if late — dedup breaks or partitioning blocked | `content_claims` design up front; itest asserting dedup semantics across the swap; joint design with 03-data-ingestion-architecture.md |
| Backpressure 429s cause client-side data loss | High today (extension deletes on rejection, fact pack §6.3) | High — silent capture loss | Valves shadow-only until the SDK retry semantics land (03); e2e test: 429 → retained → retried |
| Replica lag breaks read-your-writes on the console | Medium | Low–Medium | Rollups tolerate staleness (`asOf` surfaced); pin post-write reads to primary; lag alarm |
| Redis saturation at 10× (jobs/day ≈ 1,000+/s avg) | Medium | Medium — stalled stages | ID-only payloads; batch jobs for bulk lanes; dedicated instance; shard per stage class at the trigger |
| Volume model is uncalibrated (suite's own flag, fact pack §2.1) | High | Medium — mis-sized pools, watermarks, triggers | Calibrate against staging-tenant telemetry + k6 before GA; quarterly re-baseline via revived `capacity.ts` |
| Premature Citus adoption | Low | High — migration + ops cost with no benefit | Hard trigger definition; partitioning + replicas + batching first (the OpenAI pattern, fact pack §7.3) |
| Co-located workers starve API/lock renewal on the shared VM | Medium | Medium — stalled jobs, failed acks | F1 compose limits; CPU-heavy parse off the event loop; separate worker VM when leaving single-VM (16-technology-recommendations.md) |
| Auto-approve threshold mis-calibrated to protect the review ceiling | Medium | High — quality regression in gold at scale | Calibrated threshold with QA sampling + honeypots (fact pack §11.2); threshold changes gated by the eval harness (05, 11) |

## Success metrics

1. **Ingest ack p95 <300ms / p99 <800ms** at a sustained 350 rps (baseline peak) k6 run, and
   p95 <500ms at a 3,500 rps burst, measured at the edge.
2. **No `leadwolf_forge` transaction open >5s** during landing (pg_stat_activity monitor
   alarmed); zero S3 calls inside any open transaction (asserted by an itest instrumenting the
   land path).
3. **Redis memory flat over a 7-day soak** at baseline job rates; total retained jobs bounded
   by the removeOn* policy; zero stalled-job incidents in the soak.
4. **`GET /bff/overview` p95 <200ms** against a 100M-row synthetic dataset (rollup point
   read), with per-route rate limits enforced.
5. **All seven append-heavy tables partitioned** with pg_partman premake ≥3 and automated
   maintenance green; retention executed as `DROP PARTITION` in <1s.
6. **Freshness SLOs met at baseline:** 95% of captures parsed within 5 min; outbox
   oldest-pending p99 <60s with drain capacity ≥50/s demonstrated.
7. **ER candidate budget enforced:** <50 candidates/record p99, block-size caps active, full
   backfills run offline (with 05-entity-resolution.md).
8. **The volume model is calibrated:** predicted vs observed rates within ±30% for two
   consecutive months at whatever live volume exists; re-baselined quarterly.
9. **Ceiling headroom visible:** dashboards show AI spend vs per-tenant budget and
   review-queue inflow vs the 5–15K/day ceiling; auto-approve rate ≥99% of verified flow at
   baseline (with 11-ai-assisted-processing.md).
10. **A green 2× load test in CI is a required gate** before any capture flag flips for a
    non-synthetic tenant; a green 10× stress run before GA.

## Effort & priority

**P1 overall, with a P0-grade F1 slice.** Nothing in this document blocks the pipeline today —
volume is zero and the P0 correctness inventory lives in doc 01 — but the moment any capture
flag flips, P-14.1/P-14.2/P-14.5 become production incidents within hours, so the F1 slice
(invert the land transaction, measured caps, queue hygiene, bounded pools, BFF
stopgap, resource limits, saturation metrics: ~3–4 eng-weeks) must land **before** first real
traffic and inherits P0 urgency where it overlaps doc 01 (P-01.7, P-01.13, P-01.17, P-01.21).
The F3 structural work (partitioning, rollups, replica routing, backpressure + fairness,
drain shape, load harness: ~8–11 eng-weeks) is the enterprise-readiness core and is cheap now
precisely because tables are small. F4 (~3–5 eng-weeks initial) is deliberately trigger-gated —
the research is unambiguous that Citus/OpenSearch/brokers adopted early are pure cost (fact
pack §7.3, §7.6). Total 14–20 eng-weeks for the 2–3-engineer pod, interleaved with
08-pipeline-architecture.md and 09-storage-strategy.md, which share several workstreams.

## Future enhancements

- **KEDA autoscaling on queue depth + age** once the platform leaves single-VM Compose
  (deploy-target evolution owned by 16-technology-recommendations.md); until then the revived
  `capacity.ts`/`desiredWorkers` model drives documented manual scaling.
- **Citus scale-out of the `forge` schema** at the write-saturation trigger, with a joint
  ER/identity-graph placement design (05-entity-resolution.md, 06-identity-graph.md).
- **Queue sharding / dedicated Redis per stage class** past ~50K jobs/min sustained; a broker
  (Redpanda/NATS) only at sustained 5–10K+ msg/s multi-team streams (fact pack §7.6).
- **BullMQ Pro** if app-level per-tenant fairness proves insufficient (groups + batches, fact
  pack §10.2).
- **Per-tenant performance SLAs** (rate and freshness tiers) as a sellable enterprise feature
  once fairness plumbing exists.
- **Predictive capacity planning:** feed production telemetry back into the capacity model and
  alert on trend-based exhaustion (disk, Redis, pool, ceiling headroom) weeks ahead.
- **Multi-region read serving and residency-driven silos** (F4+, with
  13-security.md's residency work) — read replicas per region first; active-active is
  explicitly out of scope.
- **ClickHouse-backed console analytics** (capture trends, per-tenant volumes, cost curves)
  once the telemetry offload exists — the console never grows OLTP aggregate queries back.
