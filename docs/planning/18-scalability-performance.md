# 18 — Scalability & Performance

> The quantified performance contract: how LeadWolf serves **millions of users**, **thousands of
> concurrent users per workspace**, **100M+ overlay rows / billions in the master graph**, and
> **real-time** operations without degradation. The numbers here are the contract `10` schedules,
> [ADR-0024](./decisions/ADR-0024-performance-slos-and-capacity-model.md) locks, and `19` observes.

## 1. The bar (design targets)

| Dimension | Target |
|---|---|
| Registered users | millions (global identity, [ADR-0019](./decisions/ADR-0019-global-identity-and-tenant-membership.md)) |
| Concurrent users / large workspace | ≥ 5,000 |
| Overlay scale (Layer 1) | 100M+ rows/workspace-tenant aggregate, Aurora Serverless v2 |
| Master graph (Layer 0) | billions of golden records, Citus-sharded ([ADR-0021](./decisions/ADR-0021-global-master-graph-and-overlay.md)) |
| Core API availability | **99.9%** monthly |
| Real-time index/UI freshness | CDC→index p95 < 5 s; live UI via SSE (`20`) |

Stateless API + workers scale **horizontally** on ECS Fargate ([01](./01-tech-stack.md), [02 §2](./02-architecture.md));
the database and search tiers scale as in §6–§8. No request holds server state between calls.

## 2. SLOs & latency budgets

Server-side budgets (exclude client network), enforced as SLOs in [19](./19-observability-reliability.md)
with monthly **error budgets**:

| Path | p95 | p99 |
|---|---|---|
| Masked search ([09 §3.1](./09-api-design.md)) | 200 ms | 500 ms |
| Reveal (in-tx, H1) | 300 ms | 800 ms |
| List / results grid page | 150 ms | 400 ms |
| Record detail | 150 ms | 400 ms |
| Import / export enqueue | 100 ms | 300 ms |
| AI assistive first token (`23`) | 1.5 s | 3 s |

**Async freshness SLOs:** enrichment p95 < 10 min · **bulk-enrichment job** p95 < 30 min for a 100k-row
file (§11, target) · scoring p95 < 5 min · search-sync (CDC→index) p95 < 5 s ·
bounce→suppression p95 < 2 min · automation reaction (`27`) p95 < 30 s.

## 3. Capacity model & scaling units

| Tier | Unit | Scaling signal |
|---|---|---|
| API (`apps/api`) | ECS task | CPU + request concurrency; target-tracking autoscale |
| Workers (`apps/workers`) | ECS task / queue | **queue depth + age** per domain (§9) |
| Overlay DB | Aurora Serverless v2 ACUs | CPU/connections; auto-scale |
| Master graph | Citus coordinator + workers | shard count (§8) |
| Search | Typesense (overlay) / OpenSearch (global) nodes | QPS + index size |
| Analytics | ClickHouse + Aurora read replica | query load (§6) |
| Cache/realtime | ElastiCache Redis (cluster mode) | memory + connections |

Each tier has a documented **headroom target** (e.g. autoscale at 60% to absorb spikes) tracked in `19`.

## 4. Connection pooling at scale

- **RDS Proxy** (transaction pooling) fronts Aurora; the API never opens raw DB connections. Pool size is
  sized to `min(Aurora max_connections × safety, expected concurrent tx)`, with documented saturation
  behavior (queue then fail-fast with a typed `503`, never hang).
- **GUC discipline (H9):** `SET LOCAL app.current_tenant_id` / `app.current_workspace_id` **inside every
  transaction** — the proxy resets GUCs per checkout ([03 §9](./03-database-design.md), [02 §4](./02-architecture.md)).
- Long/heavy reads (reports, exports) go to **replicas/ClickHouse** (§6), keeping the writer pool for OLTP.

## 5. Caching tiers & invalidation

Typed cache layers (Redis + in-process), each with an **explicit policy** — no unbounded staleness on
money/permission paths:

| Cache | TTL | Invalidation |
|---|---|---|
| Entitlements / plan / team budgets | short (≤ 60 s) | **invalidate-on-write** (entitlement/budget change) |
| Reveal-state / contact summary | medium | invalidate-on-write (reveal, edit) via outbox event (`20`) |
| Search facet counts | medium | refreshed by search-sync; bounded staleness OK |
| Enrichment provider results | long (`06 §5`) | request-hash keyed; idempotent |
| AI results (`ai_cache`, `23`) | per task | prompt+grounding hash keyed |

Invalidation is driven by **domain events** ([20](./20-event-driven-realtime-backbone.md)) so writes fan
out to caches and indexes consistently. Money and permission decisions are **never** served from a stale
cache.

## 6. Read-scaling (analytics off the primary)

- **Reporting/analytics** (Reports surface, `11 §4.5`) read from **ClickHouse** (CDC-fed) and **Aurora
  read replicas** — never the primary writer.
- **Heavy exports** run on workers against replicas, streamed to S3 with signed URLs (`05 §12`).
- Per-tenant **search quotas** (`09`) prevent one tenant's global-search load from starving others.

## 7. Partitioning & hot-key strategy

- High-volume tables are **range-partitioned by month** ([03 §12](./03-database-design.md)): `activities,
  audit_log, contact_reveals, intent_signals, scores, source_imports, outreach_log, provider_calls,
  source_records`, plus new `automation_runs, ai_requests, outbox`.
- **UUID v7** PKs give append locality; hot tenants/workspaces are spread by including `workspace_id` in
  composite indexes; no monotonic single-row counters on the hot path except the in-tx credit counter
  (`H2`) and team-budget counter (`H18`), both `FOR UPDATE`-guarded and short-held.

## 8. Citus sharding & cutover

- The **master graph** golden tables (`master_persons/companies/emails/phones/employment`,
  `source_records`, `match_links`) move from a single Aurora writer to **Citus hash-shards** (by
  entity/blocking key) at a documented threshold — target cutover **before ~500M golden rows or sustained
  writer CPU/connection pressure**, whichever first ([ADR-0021](./decisions/ADR-0021-global-master-graph-and-overlay.md)).
- Raw evidence offloads to **S3/Iceberg**; batch ER (Splink) runs on Spark/Athena (`22`).
- The **overlay** stays on Aurora Serverless v2 (RLS-scoped); it does not shard with the master graph.

## 9. Rate limiting, quotas & backpressure

- **API:** per-session + per-API-key Redis token buckets; `429` + `Retry-After` ([09 §1/§5](./09-api-design.md));
  per-tenant quotas for global search + AI.
- **Backpressure:** each queue has depth/age thresholds → autoscale workers, then **shed or slow
  producers** (e.g. defer non-urgent enrichment) before the freshness SLOs (§2) break; DLQ + alerts on
  exhaustion (`20`).
- **AI/enrichment budgets:** per-workspace/tenant cost budgets with circuit breakers (`06 §6`, `23`).

## 10. Load, soak & capacity testing

- **k6/Gatling** scenarios per critical path (search, reveal, import, export, AI) run in CI against
  staging; targets are the §2 budgets.
- **Soak tests** validate no leak/queue-creep over hours; **spike tests** validate autoscale + backpressure.
- Capacity reviews update the §3 model and the §8 cutover trigger from measured data; chaos/DR drills live
  in [19](./19-observability-reliability.md).

## 11. Bulk-enrichment at scale (M17)

Bulk CSV enrichment ([30](./30-bulk-enrichment-pipeline.md), [ADR-0036](./decisions/ADR-0036-bulk-csv-enrichment-pipeline.md))
uploads a sparse file, matches it against our own data (`MatchPort`), enriches/verifies the residual
misses, and returns a downloadable result — at enterprise file sizes. The numbers below are **design
targets validated by k6 (§10), not guarantees** (consistency check I); they extend §2, not replace it.

### 11.1 Throughput & latency targets (design)

| Path | Target (validate via k6) | Why |
|---|---|---|
| Upload → job enqueue ([09](./09-api-design.md)) | p95 < 100 ms (reuse import-enqueue budget, §2) | accept + persist `enrichment_jobs` row, fan-out is async |
| Internal-match path (per row) | measured in **seconds**, no provider call | deterministic overlay match + master-graph KV fast path (M12/M13, [ADR-0021](./decisions/ADR-0021-global-master-graph-and-overlay.md)) — internal matches are **free + fast** |
| Internal-match coverage, 100k-row file | p95 < 2 s for the matched fraction | bounded by overlay/master-graph KV reads, not by any external provider |
| Full-job (incl. residual misses) | p95 < 30 min for 100k rows (async-freshness SLO, §2) | **bounded by provider rate-limits on the residual misses only** (`06 §3/§6`); internal matches add no provider latency |

The internal-match path is the fast path: deterministic overlay/master-graph lookups (the master-graph KV
fast path is **infra-gated at M12/M13** per [ADR-0021](./decisions/ADR-0021-global-master-graph-and-overlay.md))
return in seconds with no metered cost. Only the **residual misses** hit external enrichment providers, so a
job's tail latency is governed by per-provider rate limits and the per-workspace/tenant enrichment budget
(§9, `06 §6`), **not** by file size. Higher internal hit-rates shorten jobs; the SLO is sized to the
provider-bound residual, not the whole file.

### 11.2 Chunking & parallelism

- A bulk file is split into **chunks** (`enrichment_job_chunks`, sized for even row counts) fanned out
  across workers via the **`BULK_ENRICHMENT_QUEUE`**; per-row state lands in `enrichment_job_rows`. The
  job → chunks → rows shape is the canonical spec ([30](./30-bulk-enrichment-pipeline.md),
  [ADR-0036](./decisions/ADR-0036-bulk-csv-enrichment-pipeline.md)).
- **Per-tenant bulk concurrency cap:** a bounded number of chunks per tenant run concurrently so one large
  job can't starve interactive jobs or another tenant's bulk work (reuses the per-tenant quota model, §9,
  `09`).
- **Backpressure:** `BULK_ENRICHMENT_QUEUE` exposes **depth + age** like every queue — thresholds trigger
  worker autoscale (§3), then **shed/slow** non-urgent bulk producers before the §2 freshness SLOs break,
  reusing the existing autoscale + backpressure model (§9, [20 §6](./20-event-driven-realtime-backbone.md),
  risk #22). Bulk sits **below** money/real-time paths in queue priority ([20 §4](./20-event-driven-realtime-backbone.md)).
- **Idempotent + DLQ:** chunk/row processors are idempotent on `(job_id, chunk_id, row_id)` so re-delivery
  is a no-op, not a double-charge; poison chunks dead-letter with alerts ([20 §4/§5](./20-event-driven-realtime-backbone.md)).
  A retried or partially-failed job resumes from incomplete rows, never re-enriching settled ones.

### 11.3 Search-sync of bulk-created overlay rows

A large bulk job can create **many overlay contacts** (matched-and-enriched rows persisted to the overlay),
all of which must reach the **Typesense overlay index** via the existing **CDC search-sync worker** — there
is no separate sync path for bulk. This is a deliberate scale interaction with **risk #8** (search strain /
drift between Aurora and the search indexes) and the **search-sync (CDC→index) p95 < 5 s** SLO (§2):

- A bulk job is a write **burst**, so the CDC search-sync worker ([20 §7](./20-event-driven-realtime-backbone.md))
  must **batch** overlay upserts and tolerate transient **lag** during the burst — bounded staleness on a
  freshly-created bulk row is acceptable, but the < 5 s SLO must recover once the burst drains.
- Bulk overlay writes inherit the backpressure rules above (§11.2): if search-sync lag breaches its SLO,
  the bulk producers slow before the index falls irrecoverably behind (risk #8, [20 §6](./20-event-driven-realtime-backbone.md)).
- Capacity reviews (§10) size the search-sync worker against the **peak bulk burst rate**, not steady-state
  writes, and feed the risk #8 lag-monitoring/reindex mitigation.

## Links
- **Links to:** [01](./01-tech-stack.md), [02 §2/§4/§9](./02-architecture.md), [03 §9/§12](./03-database-design.md),
  [09](./09-api-design.md), [10](./10-roadmap.md), [19](./19-observability-reliability.md),
  [20 §4/§6/§7](./20-event-driven-realtime-backbone.md), [30 §8](./30-bulk-enrichment-pipeline.md),
  [ADR-0024](./decisions/ADR-0024-performance-slos-and-capacity-model.md),
  [ADR-0010](./decisions/ADR-0010-aws-native-self-hosted-stack.md), [ADR-0021](./decisions/ADR-0021-global-master-graph-and-overlay.md),
  [ADR-0036](./decisions/ADR-0036-bulk-csv-enrichment-pipeline.md), [ADR-0037](./decisions/ADR-0037-bulk-enrichment-match-and-fan-out.md)
- **Linked from:** [00 §7](./00-overview.md#7-decision-log), [02 §9](./02-architecture.md), [10](./10-roadmap.md), README

## Open questions
1. Final Citus cutover threshold (row count vs. writer-pressure signal) — confirm from load tests (§8).
2. SSE vs. WebSocket connection ceiling per ECS task and the fan-out node sizing (`20`).
3. Per-tenant global-search QPS quota defaults by plan tier (`12 §6`).
