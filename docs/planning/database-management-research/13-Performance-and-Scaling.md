# 13 — Performance & Scaling

> **Series:** [Database Management](./README.md) · **Type:** Design · **Status:** ✅ Authored
> · **Prev:** [`12-Security-and-Compliance`](./12-Security-and-Compliance.md) · **Next:**
> [`14-Implementation-Roadmap`](./14-Implementation-Roadmap.md)

---

## Objective

Define the scale strategy that lets TruePoint's data-management surfaces — ingest, validate, dedup,
link, enrich, verify, search, retain — run correctly at **10× current load** while staying *safe under
load*, and pin down the limits a control panel ([04-Control-Panel-Architecture](./04-Control-Panel-Architecture.md))
must respect so an operator can never start a job that takes the platform down.

This document is the *capacity contract* for the rest of the series. It answers four questions in
concrete, codebase-grounded terms:

1. **What is the load-bearing decision?** Blocking, in deduplication. Everything else is engineering;
   the blocking key choice is the one that decides whether a run is `O(n)` or `O(n²)`. (02 dim 22; cross-ref
   [07-Deduplication-and-Linking](./07-Deduplication-and-Linking.md#43-blocking--the-load-bearing-scale-lever-02-dim-22))
2. **Where does the work run, and how is it bounded?** COPY-staged, chunked, queue-driven, leader-locked,
   with a dedicated bulk lane below interactive traffic and a per-tenant/global cost ceiling.
3. **How does a tenant-scoped read stay cheap?** The two-round-trip RLS setup in `withTenantTx`
   (`packages/db/src/client.ts:74`), `prepare:false` pooling, partial-unique + blind-index + GIN
   coverage, and the `SearchPort` seam for when Postgres `ILIKE` stops being enough.
4. **What are the numbers, and how do we prove them?** Concrete capacity targets and a load/soak strategy
   with a per-read latency floor as the hard gate.

> **Precedence note (CLAUDE.md).** Platform owns tenancy (RLS), the API contract, and scale; this doc is
> Platform's. But a fast path is not an excuse to skip a slow, correct one: a cross-tenant write still goes
> through `withPlatformTx` (audited), a tenant write still goes through `withTenantTx` (RLS-enforced), and
> **structure/perf rules never override correctness rules**. The `ownerClient` COPY fast-path
> (`client.ts:27`) is the single sanctioned exception, and it carries an explicit `workspace_id` predicate
> on *every* staging query in lieu of RLS.

---

## Current Challenges

The platform today is correct-but-small. The data subsystems were built for tens-of-thousands-of-rows
workspaces and a handful of active imports; the scale primitives exist but are mostly **un-exercised at
volume, un-instrumented, or dark**. Concretely:

| Challenge | Where it bites | Status |
|---|---|---|
| **Dedup is all-pairs-shaped today.** Within-workspace dedup is Shipped with auto-survivorship but blocking keys are not measured against real data; at 1M contacts/ws an unblocked pass is 5×10¹¹ comparisons. | `packages/core/src/prospect/dedup.ts`, dedup queue | **Shipped, unmeasured** |
| **Bulk COPY path is unverified.** `copyRows` (COPY FROM STDIN) has never run against real Postgres on Bun; no production object store, only dev-disk `FileStore` (`BULK_IMPORT_STORAGE_DIR`, `env.ts:181`). | `apps/api/.../bulkRoutes.ts`, `packages/core/src/import/bulkStage.ts` | **Dark** (`BULK_IMPORT_ENABLED=false`, `env.ts:174`) |
| **No dedicated bulk lane.** All queues share one IORedis and default concurrency; a 2M-row import will starve interactive reveals/enrichment. | `apps/workers/src/register.ts` | **Partial** |
| **RLS setup cost on every read.** Each `withTenantTx` pays two extra round-trips (`SET LOCAL ROLE` + `set_config`) before the first query (`client.ts:76-91`). Fine at low QPS; an amplifier under fan-out. | `packages/db/src/client.ts:74` | **Shipped, by design** |
| **Search is Postgres `ILIKE` + keyset.** Works to ~single-digit-million rows/ws; no engine adapter wired. Trigram/GIN scale columns are deferred. | `searchRepository.ts`, `packages/search` `SearchPort` | **Shipped (PG), adapters deferred** |
| **Enrichment spend is bounded but not load-tested.** Provider budgets + `PLATFORM_READ_LIMIT=500` exist; worst-case pre-compute for a bulk run is not wired into a gate. | `enrichmentJobs`, `provider-configs` | **Partial** |
| **Global ER (master graph) has no scale story.** `masterGraphMatcher` is a STUB; Splink + DSU clustering across `master_persons` is deferred. | `packages/core/src/enrichment/bulk/masterGraphMatcher.ts` | **Missing** |
| **No load/soak harness, no latency SLOs.** `system-health` shows live queue depth but there is no labelled load test and no per-read latency floor enforced in CI. | `features/system-health` | **Missing** |

See [01-Current-State-Analysis](./01-Current-State-Analysis.md#10-status-summary-the-one-table-to-remember) §10 for the full status matrix
and [03-Gap-Analysis](./03-Gap-Analysis.md) for the gap register these map to.

---

## Enterprise Best Practices

All citations link to [02-Enterprise-Research](./02-Enterprise-Research.md). The three dimensions this
doc owns end-to-end:

### Dim 22 — Scalability: blocking is the load-bearing decision

> *"BLOCKING is the load-bearing decision (n(n-1)/2; strict OR rules measured before run); DSU clustering
> on a distributed engine; file-async for huge loads; metered under-management enrichment."*
> — [02 §dim-22](./02-Enterprise-Research.md#422-scalability-strategies)

The all-pairs comparison count is `n(n-1)/2`. At n = 1M that is ~5×10¹¹ pairs — infeasible. **Blocking**
partitions records into buckets where only same-bucket pairs are compared; the block *predicate* (an
OR-combination of strict keys — exact email, normalized domain+lastname, LinkedIn public id) is what
determines the real comparison count, and it **must be measured on real data before a run** because a bad
block key either explodes (one giant bucket) or silently drops true matches (over-narrow buckets). At
scale, clustering the surviving edges into entities uses **DSU / Union-Find** over connected components,
which is near-linear, rather than transitive-closure joins. Huge loads go **file-async** (not sync API),
and enrichment is **metered under management** — spend is a managed resource, not an unbounded side effect.

### Dim 18 — Queue management: a dedicated bulk lane below interactive

> *"DEDICATED BULK LANE below interactive (Apollo bulk ~50% of single-endpoint limit); multi-window limits
> + quota/reset headers + 429; anticipate parent-lock contention."* — [02 §dim-18](./02-Enterprise-Research.md#418-queue-management)

Bulk work runs in its own queue/worker lane, capped *below* interactive capacity (Apollo runs bulk at
~50% of the single-endpoint limit) so a large batch never starves a user reveal. Rate limits are
multi-window with quota/reset headers and explicit 429s, and the design **anticipates parent-lock
contention** (many child rows updating the same parent account row) by sorting same-parent rows together,
serializing, small-batching, and retrying.

### Dim 23 — Performance: the six laws

> *"normalize BEFORE compare; deterministic-first then fuzzy on residue; DEDUPE BEFORE ENRICHMENT; stop
> waterfall at first hit; cap response size; sort same-parent rows; re-verify on access / incremental
> update."* — [02 §dim-23](./02-Enterprise-Research.md#423-performance-optimization)

Plus the supporting dims this doc leans on: **dim 3** (atomic phases + recovery points; staging-then-promote;
completer/reaper workers — [02 §dim-3](./02-Enterprise-Research.md#43-import-pipelines)), **dim 8**
(ordered waterfall per field, stop at first pass, charge only on success — [02 §dim-8](./02-Enterprise-Research.md#48-enrichment-pipelines)),
**dim 6** (DSU connected components, Fellegi-Sunter weights — [02 §dim-6](./02-Enterprise-Research.md#46-record-linking)),
and **dim 17** (async + webhook for very large batches — [02 §dim-17](./02-Enterprise-Research.md#417-background-jobs)).

### The six performance laws, restated as TruePoint invariants

| # | Law (02 dim 23) | TruePoint enforcement point |
|---|---|---|
| 1 | **Normalize before compare** | `prepareContact.ts` lowercases/trims/strips before the email blind index (HMAC) and domain are computed; comparison never sees raw input. |
| 2 | **Deterministic-first, fuzzy on residue** | Exact keys (email blind index, LinkedIn public id) resolve first; only unmatched residue is eligible for probabilistic ER (deferred Splink). |
| 3 | **Dedupe BEFORE enrich** | `imports completed → fan out enqueueDedup + enqueueFirmographics + enqueueMasterBackfill`; enrichment never spends on a row that dedup will collapse. |
| 4 | **Stop waterfall at first hit** | `enrichment/waterfall.ts` stops at the first provider result that *passes validation*, falls through on empty/invalid; charge only on success. |
| 5 | **Cap response size** | Keyset pagination `limit 1..200 default 50` (`packages/types/src/search.ts`); `PLATFORM_READ_LIMIT=500` clamps every cross-tenant list. |
| 6 | **Re-verify on access / incremental** | `last_verified_at` freshness clock + `reverification-sweep`; verification is lazy + incremental, never a full re-scan. |

---

## Gaps in Current Implementation

Mapped to [01-Current-State-Analysis](./01-Current-State-Analysis.md) §10 and the
[03-Gap-Analysis](./03-Gap-Analysis.md) register. Tiers use the canonical phasing (see §Rollout).

| Gap | Best practice violated | Current | Target tier |
|---|---|---|---|
| **G-P1 Blocking keys not measured** — no instrumentation of bucket sizes / comparison counts before a dedup run | Dim 22 | Shipped dedup, no measurement | MVP/Phase 0 (instrument) → Phase 1 (gate) |
| **G-P2 COPY FROM STDIN unverified on Bun** — `copyRows` never run against real PG; no prod object store | Dim 3 | Dark | MVP/Phase 0 (enable-and-harden) |
| **G-P3 No dedicated bulk lane** — all queues share concurrency; bulk starves interactive | Dim 18 | Partial | MVP/Phase 0 (lane) → Phase 1 (limits) |
| **G-P4 No worst-case spend pre-compute gate** — bulk enrichment can be started without a cost ceiling check | Dim 16/22 | Partial | Phase 1 |
| **G-P5 Search engine adapters deferred** — `SearchPort` has only the in-memory/PG adapter | Dim 22 | Shipped (PG) | Phase 3+ |
| **G-P6 Global ER scale track missing** — `masterGraphMatcher` STUB; no DSU/Splink | Dim 6/22 | Missing | Phase 3+ |
| **G-P7 No load/soak harness, no latency SLO gate** — no labelled load test; no per-read floor in CI | Dim 20 | Missing | Phase 0 (harness) → all phases (gate) |
| **G-P8 RLS two-round-trip cost unmeasured under fan-out** — known amplifier, not benchmarked | — | Shipped by design | Phase 0 (benchmark) |

---

## Recommended Solution

A layered capacity architecture. Each layer has a hard limit, an owner, and an enforcement point.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ L5  COST / METER       provider budgets · PLATFORM_READ_LIMIT=500 · worst-case │
│                        spend pre-compute gate (preview-then-commit, 02 dim16)  │
├──────────────────────────────────────────────────────────────────────────────┤
│ L4  SEARCH / READ      keyset (limit≤200) · partial-unique + HMAC blind idx +  │
│                        GIN jsonb · SearchPort seam (PG today → OS/Typesense)   │
├──────────────────────────────────────────────────────────────────────────────┤
│ L3  POOL / RLS         postgres.js max=10 · prepare:false · SET LOCAL ROLE +   │
│                        LOCAL GUCs per tx (2 round-trips) · RDS-Proxy/PgBouncer  │
├──────────────────────────────────────────────────────────────────────────────┤
│ L2  QUEUE / LANE       dedicated BULK lane < interactive · concurrency caps ·  │
│                        backpressure · DLQ + replay · leader-locked sweeps      │
├──────────────────────────────────────────────────────────────────────────────┤
│ L1  STAGE / CHUNK      COPY → UNLOGGED staging (ownerClient) · import_job_chunks│
│                        · completer/reaper · staging-then-promote (02 dim 3)     │
├──────────────────────────────────────────────────────────────────────────────┤
│ L0  COMPUTE LAW        normalize→dedup→enrich→verify; deterministic-first;     │
│                        blocking is load-bearing (n(n-1)/2 measured pre-run)     │
└──────────────────────────────────────────────────────────────────────────────┘
```

### L0 — Compute laws (the dedup blocking decision)

The single most important number in the platform is the **comparison count of a dedup/ER run**, governed
by the blocking predicate. The design:

- **Block, never all-pairs.** Candidate pairs come only from records sharing a *strict block key*:
  `email_blind_index` (exact), `lower(email_domain) || surname_norm`, `linkedin_public_id`,
  `sales_nav_lead_id`. These are **OR-combined**: a pair is a candidate if it collides on *any* key.
  (02 dim 5, dim 22; mechanics in [07](./07-Deduplication-and-Linking.md#43-blocking--the-load-bearing-scale-lever-02-dim-22).)
- **Measure before you run.** Every dedup job first runs a **block-profile query** (count rows per block
  key value) and computes `Σ b_i·(b_i−1)/2` over buckets — the real candidate-pair count — and the **max
  bucket size**. If estimated candidate pairs exceed a ceiling (default 50M) or any single bucket exceeds
  100k rows, the run is **rejected** with a `BlockExplosionError` and the operator is told which block key
  is degenerate (e.g. everyone at `gmail.com`, so domain alone is a bad key). This is the dim-22 "strict
  OR rules measured before run" mandate made executable.
- **Deterministic-first, fuzzy on residue.** Exact-key collisions auto-resolve (auto-survivorship,
  Shipped). Only the *residue* (records with no exact collision but a probabilistic candidate) goes to the
  deferred Splink path and the clerical review queue ([09](./09-Review-and-Approval-System.md),
  [07](./07-Deduplication-and-Linking.md)).
- **DSU clustering at scale.** Surviving match edges are clustered with Union-Find into connected
  components → `match_links.cluster_id`; never transitive-closure SQL joins. (02 dim 6.)

### L1 — Stage & chunk (the bulk ingest path)

- **COPY into UNLOGGED, non-RLS staging.** Bulk loads stream via `COPY FROM STDIN` on `ownerClient`
  (`client.ts:27`) into a per-job UNLOGGED staging table (Postgres forbids COPY on RLS tables). Isolation
  is the explicit `workspace_id` predicate on every staging query (access path), reviewed by Security.
- **Chunked drain.** Rows are partitioned into `import_job_chunks`; chunk workers validate → dedup-key →
  promote into `contacts` via `withTenantTx` (RLS-enforced on the real write). `import_job_rows` carries a
  denormalized `workspace_id` for per-row status.
- **Recovery points + completer/reaper.** Each chunk is an atomic phase with a checkpoint; a **completer**
  worker promotes a job to `completed`/`partial` once all chunks settle; a **reaper** (leader-locked sweep)
  re-enqueues chunks stuck in `running` past a lease deadline so a crashed worker self-heals (02 dim 3).
- **Enable-and-harden gate (G-P2).** Before flipping `BULK_IMPORT_ENABLED`: (a) verify `copyRows` against
  real Postgres on Bun (the COPY spike), (b) wire a production object-store adapter behind the `FileStore`
  interface replacing dev disk, (c) confirm `idempotency_key` (ws-unique) + `content_hash` dedupe re-uploads.

### L2 — Queue & lane (dedicated bulk lane)

- **A dedicated bulk lane below interactive.** `imports`/`enrichment`/`reveal` are *interactive-adjacent*;
  `bulk-imports`, `master-backfill`, `reverification`, `data-quality-snapshot`, `data-retention` are
  *background*. Background workers run at **≤50% of interactive concurrency** (02 dim 18) and at lower
  BullMQ priority so the shared IORedis never lets a 2M-row backfill starve a user reveal.
- **Backpressure.** Each queue has a `concurrency` cap and a BullMQ `limiter {max, duration}`; producers
  check queue depth (already surfaced in `system-health`) and **shed/slow** new bulk admissions when depth
  exceeds a high-water mark instead of unboundedly enqueuing.
- **DLQ + replay.** Every queue has a `.dlq` partner; a failed job lands in the DLQ with its correlation
  token. The staff console ([10](./10-Monitoring-and-Observability.md)) gets an audited **DLQ replay**
  action (`data:manage` + JIT for high-risk) that re-enqueues with the original idempotency key — replay is
  safe because receivers are idempotent (02 dim 17/19).
- **Parent-lock contention.** Account-touching child rows (firmographics, account upserts) are **sorted by
  `account_id`** and small-batched so many rows don't serialize on one parent row lock (02 dim 18).

### L3 — Pool & RLS (the per-read floor)

- **`postgres.js max=10`, `prepare:false`** (`client.ts:13`) — `prepare:false` is mandatory for RDS Proxy /
  PgBouncer transaction pooling; prepared statements don't survive a per-checkout reset.
- **The two-round-trip RLS setup** (`client.ts:76-91`): `SET LOCAL ROLE leadwolf_app` (utility command,
  cannot be parameterized or merged) + a **single** `set_config(...)` SELECT collapsing both GUCs. This is
  already optimized from three round-trips to two and is the *per-read latency floor under every
  authenticated endpoint* — the design goal is to keep it at two and never regress to three.
- **Right pool size for fan-out.** Cross-tenant rollups (Data-Ops Overview) must **not** open one
  `withTenantTx` per tenant in a loop — that multiplies the two-round-trip cost by tenant count and can
  exhaust `max=10`. Rollups read pre-aggregated `data_quality_snapshots` via a single `withPlatformTx`
  (owner connection, RLS-bypass, audited) — one transaction, bounded by `PLATFORM_READ_LIMIT`.

### L4 — Search & read (indexing/projections)

- **Reuse the existing index posture:** per-workspace **partial uniques** (`uniq_contacts_ws_email`,
  `uniq_accounts_ws_domain`), **HMAC blind indexes** (`email_blind_index`) for equality without exposing
  PII, **GIN** on `custom_fields` and `technologies` (jsonb). Trigram/GIN scale columns for fuzzy search are
  deferred until the PG search adapter is replaced.
- **Projection / search pattern.** Heavy list/search reads do not scan `contacts` wide; they read a narrow
  projection (id, name, title, account, status, `priority_score`, `last_activity_at`) ordered by a keyset
  cursor. `searchRepository.ts` already does ILIKE + keyset inside `withTenantTx`.
- **`SearchPort` seam (deferred adapters, G-P5).** When PG `ILIKE` stops scaling (~single-digit-million
  rows/ws or once fuzzy/relevance is required), swap the adapter behind `packages/search` `SearchPort`:
  **OpenSearch** for global/master-graph search, **Typesense** for per-workspace overlay search. The seam
  exists so this is an adapter swap, not a rewrite.

### L5 — Cost / meter (cost-bounded enrichment)

- **Provider budgets + MTD spend** (provider-configs): monthly budget, rate limit, health. A run that would
  exceed a provider's budget is rejected with `ProviderBudgetExceededError` (429).
- **`PLATFORM_READ_LIMIT=500`** (`platformAdminReads.ts:17`) clamps every cross-tenant list — no unbounded
  fleet scans.
- **Worst-case spend pre-compute gate (G-P4).** A bulk enrichment run computes `rows × worst-case
  per-field cost_micros` *before* it starts (preview-then-commit, 02 dim 16) and refuses if it exceeds the
  tenant's remaining budget — *charge only on success* still holds per row, but the ceiling is checked up
  front so a run can't silently blow a budget.

---

## Implementation Steps

1. **Block-profiling instrumentation (G-P1, G-P7).** Add a `blockProfile(tx, scope, keys[])` helper in
   `packages/core/src/prospect/dedup.ts` returning `{ keyValue, bucketSize }[]`, the derived candidate-pair
   estimate, and max bucket size. Emit as metrics; log into the dedup job record.
2. **Block-explosion gate.** In the dedup worker, run `blockProfile` first; reject with `BlockExplosionError`
   when `estimatedPairs > DEDUP_MAX_PAIRS` (default 50M) or `maxBucket > DEDUP_MAX_BUCKET` (default 100k).
   Surface the offending block key to the operator.
3. **Dedicated bulk lane (G-P3).** In `apps/workers/src/register.ts`, give background queues
   (`bulk-imports`, `master-backfill*`, `reverification*`, `data-*-sweep`) explicit `concurrency` and
   `limiter` set to ≤50% of interactive; set lower job priority. Add a high-water-mark admission check in
   the bulk producers.
4. **COPY spike + object store (G-P2).** Run `copyRows` against real Postgres on Bun (the COPY FROM STDIN
   spike). Implement a production object-store adapter behind `FileStore` (S3-compatible); keep dev disk for
   local. Verify `idempotency_key` + `content_hash` re-upload dedupe. This is the enable gate for
   `BULK_IMPORT_ENABLED` (still per-tenant flag `bulk_import_enabled`).
5. **Completer/reaper hardening.** Use the `lease_expires_at` / `last_error` lease columns on
   `import_job_chunks` (owned by doc 05); a leader-locked reaper sweep re-enqueues expired-lease chunks
   (bumping the existing `attempts`); the completer settles `completed`/`partial` from chunk counters.
6. **DLQ replay action.** Add an audited `POST /admin/data/queues/:queue/dlq/:jobId/replay` (`data:manage`,
   `withPlatformTx`, JIT for high-risk queues) re-enqueuing with the original idempotency key.
7. **Worst-case spend gate (G-P4).** Add `estimateWorstCaseSpend(jobSpec)` in
   `packages/core/src/enrichment/bulk/estimate.ts`; the bulk enrichment endpoint refuses over-budget runs
   (`ProviderBudgetExceededError`, 429) and echoes the pre-computed ceiling in the preview.
8. **Fan-out-safe rollups.** Ensure Data-Ops Overview reads `data_quality_snapshots` aggregates via one
   `withPlatformTx`, never a per-tenant `withTenantTx` loop.
9. **Load/soak harness + latency SLO gate (G-P7, G-P8).** Build a k6/Bun load harness (see Testing) with a
   labelled dataset; wire a CI smoke (small) that fails the build if the per-read p95 floor regresses.
10. **SearchPort adapter prep (G-P5, deferred).** Document the OpenSearch/Typesense adapter contract; no
    build until a workspace crosses the PG ceiling.

---

## UI/UX Requirements

The operator-facing surface for this doc is the **Capacity & Throughput** panel inside Data-Ops Monitoring
([10-Monitoring-and-Observability](./10-Monitoring-and-Observability.md)). It is read-mostly with two
guarded write actions (DLQ replay, throttle a lane). Built in `apps/admin` following the
`features/system-health` + `features/retention` templates.

### Components used (`@leadwolf/ui`)

`StateSwitch` (four-state wrapper), `LoadingState`/`Skeleton`, `EmptyState`, `ErrorState`, `StatTile`
(throughput KPIs), `DataTable` + `Column<T>` (queue/lane table, sortable), `StatusBadge` + `StatusTone`
(lane health, DLQ depth tone), `Tabs` (Lanes | Dedup blocking | Spend), `SegmentedControl` (time window),
`TpButton` + `Dialog` + `TpTextarea` + `useToast` (DLQ replay with mandatory justification, mirroring
`TenantActions.tsx`), `Tooltip`, `Card`, `Pagination` (DLQ list keyset).

### Wireframe — Capacity & Throughput

```
┌─ Data management ▸ Monitoring ▸ Capacity & Throughput ───────────────────────────────┐
│  [ Lanes ]  Dedup blocking   Spend                       window: ‹ 1h │ 24h │ 7d ›    │
│                                                                                        │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐                          │
│  │ Ingest     │ │ Reveal p95 │ │ Bulk lane  │ │ DLQ total  │   ◀ StatTile ×4          │
│  │ 142k rows/h│ │   78 ms    │ │  41% cap   │ │   3 jobs   │                          │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘                          │
│                                                                                        │
│  QUEUE LANES                                          ◀ DataTable<LaneRow>             │
│  ┌──────────────────┬───────┬────────┬───────┬─────────┬───────────┬────────────────┐ │
│  │ Queue            │ Lane  │ Active │ Waiting│ Conc.  │ DLQ       │ Health         │ │
│  ├──────────────────┼───────┼────────┼───────┼─────────┼───────────┼────────────────┤ │
│  │ imports          │ inter │   6    │   12   │  8      │  0        │ ● healthy      │ │
│  │ enrichment       │ inter │   4    │   31   │  8      │  1        │ ● degraded     │ │
│  │ bulk-imports     │ bulk  │   2    │  118   │  4 (50%)│  0        │ ● healthy      │ │
│  │ master-backfill  │ bulk  │   1    │  9k    │  2      │  2 ▸replay│ ● healthy      │ │
│  │ data-retention   │ bulk  │   0    │   0    │  1      │  0        │ ● idle         │ │
│  └──────────────────┴───────┴────────┴───────┴─────────┴───────────┴────────────────┘ │
│                                                                  [ Throttle lane ]     │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

**Dedup blocking tab** shows, per pending dedup job, the block-profile: bucket-size histogram, estimated
candidate pairs vs the 50M ceiling (red over), and max bucket vs 100k — so an operator sees *why* a run was
rejected before they start it.

### Four states (mandatory)

- **Loading** — `StateSwitch`→`LoadingState`; `StatTile` and `DataTable` rows render as `Skeleton`. No
  layout shift.
- **Empty** — `EmptyState` "No active lanes in this window" with the window `SegmentedControl` still live
  (an empty window is normal, not an error).
- **Error** — `ErrorState` rendering `problemMessage(res, 'Failed to load capacity metrics')` from the
  RFC-7807 detail/title; a Retry calls the hook's `reload()`.
- **Data** — the table + tiles above; degraded/over-budget rows carry a `StatusBadge` with `danger`/`warn`
  tone and a `Tooltip` explaining the threshold breached.

Hooks are hand-rolled `useCapacityMetrics()` returning `{data, loading, error, reload}` (no TanStack), per
the admin pattern. Spend/throughput numbers update on `reload`/poll, not websockets (MVP).

---

## Database & Backend Changes

This doc is **mostly read + tuning**; it reuses existing tables and adds *bounded* control state. No new
tenant-data tables.

### Reused (no change)

`import_jobs`, `import_job_chunks`, `import_job_rows` (chunked drain + counters), `enrichment_jobs/_chunks/_rows`
(`cost_micros`, `charged`), `data_quality_snapshots` (rollup source for fan-out-safe overview),
`match_links` (`cluster_id`, `review_status`), `contacts`/`accounts` (partial uniques, blind index, GIN),
`platform_audit_log` (every cross-tenant write here is audited via `withPlatformTx`). Provider budgets live
in provider-configs.

### Chunk lease columns (owned by doc 05 — referenced, not redefined)

For the reaper/completer (recovery points, 02 dim 3), doc 13 **relies on** the chunk-lease columns on
`import_job_chunks` that are **owned by [05-Upload-Pipeline-Design](./05-Upload-Pipeline-Design.md)** —
`lease_expires_at` and `last_error` — plus the table's **existing** `attempts` retry counter. Doc 13 does
**not** re-`ALTER` `import_job_chunks` to add these (that would duplicate `lease_expires_at`) and does
**not** add an `attempt_count` column — it uses the existing `attempts`. If a distinct `lease_owner` column
is genuinely needed for the reaper, it is added as part of **doc 05's** migration (the next sequential
migration, 0035+), not here.

```sql
-- columns OWNED BY doc 05 on import_job_chunks (referenced here, not redefined):
--   lease_expires_at timestamptz   -- reaper lease deadline (owned by 05)
--   last_error       text          -- last chunk failure detail (owned by 05)
--   attempts         smallint      -- EXISTING retry counter (use this, not a new attempt_count)
--   lease_owner      text          -- if needed, added by 05's migration (0035+)

-- reaper scan: stuck-running chunks whose lease expired (index ships with 05's migration)
CREATE INDEX IF NOT EXISTS idx_import_job_chunks_lease
  ON import_job_chunks (lease_expires_at)
  WHERE status = 'running';
```

### New: dedup block-profile audit (migration ~0036)

Persist the measured comparison count per dedup run so a rejection is explainable and a successful run is
auditable (governance, [09](./09-Review-and-Approval-System.md)).

```sql
-- migration ~0036_dedup_block_profile.sql
CREATE TABLE dedup_block_profiles (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  workspace_id      uuid NOT NULL,
  dedup_run_id      uuid NOT NULL,
  block_keys        jsonb NOT NULL,          -- ["email_blind_index","domain+surname",...]
  estimated_pairs   bigint NOT NULL,         -- Σ b_i(b_i-1)/2
  max_bucket_size   integer NOT NULL,
  decision          text NOT NULL,           -- 'accepted' | 'rejected_explosion'
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_dedup_block_profiles_ws ON dedup_block_profiles (workspace_id, created_at DESC);
```

### RLS posture & tx wrapper

- `dedup_block_profiles` carries `tenant_id`+`workspace_id` → it is a **Layer-1 overlay** table: ENABLE +
  FORCE RLS, `USING/WITH CHECK workspace_id = NULLIF(current_setting('app.current_workspace_id',true),'')::uuid`
  (the standard RLS template in `packages/db/src/rls/*.sql`). Written **only** inside `withTenantTx` by the
  dedup worker — never `ownerClient`.
- `import_job_chunks` lease columns are written by chunk/reaper workers inside `withTenantTx` (the chunk
  carries the scope) for the RLS write; the COPY *staging* table remains the `ownerClient` exception with
  its explicit `workspace_id` predicate.
- Every staff-initiated control action (DLQ replay, throttle) goes through `withPlatformTx(actor, action, …)`
  — audited, owner connection, behind a verified `pa` claim, with `data:manage` capability.

---

## API Requirements

New routers under `apps/api/src/features/admin/data/`, mounted at `/api/v1/admin/data/*`. All behind
`authn` (Bearer) → `platformAdmin` (`pa===true`) → `requireStaffRole` (active role) →
`requireCapability(...)`. RFC 9457 envelope; keyset pagination; Idempotency-Key on the mutating routes.

### `GET /api/v1/admin/data/capacity`

Capacity & throughput rollup for the panel.

- **Gate:** `requireCapability("data:read")`.
- **Query (Zod):** `{ window: z.enum(["1h","24h","7d"]).default("24h") }`.
- **Response:** `{ lanes: LaneRow[], kpis: { ingestRowsPerHour: number, revealP95Ms: number,
  bulkLaneUtilization: number, dlqTotal: number }, generatedAt: string }` where
  `LaneRow = { queue, lane: "interactive"|"bulk", active, waiting, concurrency, dlqDepth, health: StatusTone }`.
- **Errors:** `403 ForbiddenError` (no cap). **No pagination** (bounded fixed set of queues).
- **Path:** reads live BullMQ counts + aggregated `data_quality_snapshots` in **one** `withPlatformTx`
  (audited read), bounded by `PLATFORM_READ_LIMIT`.

### `GET /api/v1/admin/data/queues/:queue/dlq`

- **Gate:** `requireCapability("data:read")`.
- **Query (Zod):** `{ cursor: z.string().optional(), limit: z.number().int().min(1).max(200).default(50) }`.
- **Response:** `{ items: DlqJobRow[], nextCursor: string|null }`,
  `DlqJobRow = { jobId, failedReason, attemptsMade, correlationToken, failedAt }`.
- **Errors:** `404 NotFoundError` (unknown queue), `403`. **Keyset** pagination.

### `POST /api/v1/admin/data/queues/:queue/dlq/:jobId/replay`

- **Gate:** `requireCapability("data:manage")` + **JIT elevation** for high-risk queues (`bulk-imports`,
  `data-retention`). **Idempotency-Key required** (replay must not double-enqueue).
- **Body (Zod):** `{ reason: z.string().min(10) }` (mandatory justification, mirrors `TenantActions`).
- **Response:** `{ replayed: true, newJobId: string }`.
- **Errors:** `404` (job not in DLQ), `403`, `422 ValidationError` (missing reason), `409` (replay already
  consumed for this idempotency key).
- **Path:** `withPlatformTx(actor, "data.dlq.replay", …, { targetType: "queue_job", targetId: jobId,
  metadata: { queue, reason } })` — the platform-audit row is written **in the same transaction**.

### `POST /api/v1/admin/data/lanes/:queue/throttle`

- **Gate:** `requireCapability("data:manage")` + JIT for interactive lanes (throttling interactive is
  high-risk). **Idempotency-Key required.**
- **Body (Zod):** `{ concurrency: z.number().int().min(0).max(64), reason: z.string().min(10) }`.
- **Response:** `{ queue, concurrency }`. **Errors:** `403`, `422`, `404`.
- **Path:** `withPlatformTx(actor, "data.lane.throttle", …)`; setting `concurrency:0` pauses a lane
  (drain-only) — never destructive.

### `GET /api/v1/admin/data/dedup-runs/:runId/block-profile`

- **Gate:** `requireCapability("data:read")`. Returns the persisted `dedup_block_profiles` row:
  `{ blockKeys, estimatedPairs, maxBucketSize, decision, ceilings: { maxPairs, maxBucket } }`.
- **Errors:** `404`, `403`. Read inside `withTenantTx` (overlay table is RLS-scoped).

> New capabilities `data:read` / `data:manage` are added to the closed enum at
> `packages/types/src/staffCapability.ts` and bundled in `ROLE_CAPABILITIES` (see
> [11-Roles-and-Permissions](./11-Roles-and-Permissions.md)). `super_admin` implies all.

---

## Edge Cases & Failure Scenarios

| # | Scenario | Designed behaviour |
|---|---|---|
| E1 | **Degenerate block key** (everyone `@gmail.com`) → one 800k-row bucket | `blockProfile` flags `maxBucket > 100k`; run **rejected** `BlockExplosionError`; operator told which key; record persisted as `rejected_explosion`. |
| E2 | **Block estimate just under ceiling but real data skews higher mid-run** | Estimate is pre-run; the worker also enforces a per-batch wall-clock budget and checkpoints — a slow run is paused (`status=paused`) and resumable, never a runaway. |
| E3 | **Worker crashes mid-chunk** | Chunk lease (`lease_expires_at`) expires; leader-locked reaper re-enqueues it; `attempts++`; idempotent promote means re-run is safe (no double-insert — ws-unique email guard). |
| E4 | **DLQ replay double-fired** (operator clicks twice / retry) | Idempotency-Key + db unique replays the first response; `409` on the second. Receiver is idempotent (original idempotency key reused on re-enqueue). |
| E5 | **Bulk lane saturates Redis / interactive reveals slow** | Backpressure: bulk concurrency capped ≤50%; admission high-water-mark sheds new bulk jobs; interactive priority preserved; `system-health` shows the depth. |
| E6 | **Cross-tenant rollup opens 5,000 `withTenantTx`** (anti-pattern) | Forbidden by design — overview reads pre-aggregated snapshots via **one** `withPlatformTx`; code review + the pool (`max=10`) make the per-tenant loop fail fast, surfacing the mistake. |
| E7 | **RLS setup regresses to 3 round-trips** | Caught by the per-read latency floor in CI (§Testing); `client.ts` comment documents the 2-round-trip invariant. |
| E8 | **COPY FROM STDIN fails on Bun** (the unverified path) | Bulk import stays **Dark** (`BULK_IMPORT_ENABLED=false`); the spike is an explicit enable-gate, not a silent fallback. Standard import path is unaffected. |
| E9 | **Worst-case spend exceeds budget after preview** (price changed) | Per-row "charge only on success" still holds; the run admission re-checks budget at start; `ProviderBudgetExceededError` 429; no partial spend beyond the ceiling. |
| E10 | **Provider goes `down` mid-bulk-enrich** | Waterfall falls through to the next provider; if all exhausted, row recorded as `match_outcome=miss`, **not charged**; job completes `partial`. |
| E11 | **Parent-account lock contention** (10k rows, same account) | Rows sorted by `account_id`, small-batched, serialized per parent, retried with backoff+jitter — no deadlock storm. |
| E12 | **Search exceeds PG ILIKE capacity** for a giant workspace | Degrades to keyset-bounded results (`limit≤200`) and surfaces a "narrow your filter" hint; triggers the SearchPort adapter decision — never an unbounded scan. |

---

## Testing Strategy

### Unit

- `blockProfile` math: synthetic bucket distributions → correct `Σ b_i(b_i−1)/2` and max bucket;
  ceiling logic accepts/rejects at the boundary.
- `estimateWorstCaseSpend`: rows × worst-case `cost_micros` vs remaining budget.
- Lane config: background lanes computed at ≤50% interactive concurrency.

### Integration (real Postgres, Bun)

- **COPY spike (G-P2):** `copyRows` against real PG — load 100k rows via COPY FROM STDIN into UNLOGGED
  staging, assert row count + timing; this is the literal enable-gate for `BULK_IMPORT_ENABLED`.
- Chunk lease/reaper: kill a chunk mid-run, assert reaper re-enqueue + idempotent promote (no duplicate
  contact; `uniq_contacts_ws_email` holds).
- DLQ replay idempotency: replay twice with same key → one re-enqueue, second `409`.

### Mandatory tenant-isolation test (data is written)

`dedup_block_profiles` and the chunk-lease writes are tenant-scoped writes → **required** isolation itest
(per CLAUDE.md): open `withTenantTx` as workspace A, write a block-profile; assert workspace B (a) cannot
read it via `withTenantTx` (RLS USING denies) and (b) the row's `workspace_id` matches A. Repeat the read
attempt with B's GUCs to prove RLS, not just a WHERE clause. Mirror the existing
`platformAdminReads.itest.ts` structure.

### Load / soak (G-P7) — capacity targets

A k6/Bun harness against a labelled dataset. **Capacity targets (10× target):**

| Surface | Target |
|---|---|
| **Interactive read (search/reveal)** p95 | **< 150 ms** (hard floor; CI gate on a small smoke) |
| **Interactive read** p99 | < 400 ms |
| **RLS setup overhead** per tx | ≤ 2 round-trips, < 5 ms added |
| **Bulk ingest throughput** | ≥ 100k rows / hour / worker via COPY-staged chunks |
| **Dedup candidate-pair ceiling** | reject > 50M pairs / 100k max bucket pre-run |
| **Bulk lane** | ≤ 50% of interactive concurrency; zero interactive p95 regression under bulk load |
| **Queue depth recovery (soak)** | a 2M-row backfill drains without interactive p95 breaching 150 ms |
| **Cross-tenant rollup** | single `withPlatformTx`, ≤ `PLATFORM_READ_LIMIT` rows, < 300 ms |

**Soak:** run the 2M-row bulk backfill for 4 h while a synthetic interactive load (50 reveals/s) runs; the
gate is **the interactive p95 floor never breaching 150 ms** and Redis/PG connection counts staying flat
(no leak; `max=10` respected). **The per-read latency floor is the decisive gate** — if RLS setup or an
index regression pushes interactive p95 over 150 ms, the build fails.

---

## Rollout & Migration Plan

Canonical tiering ([14-Implementation-Roadmap](./14-Implementation-Roadmap.md)):

- **MVP / Phase 0 (Observe & Enable):** ship block-profiling instrumentation + the load/soak harness +
  per-read latency floor in CI (read-only, no behaviour change); add `data:read`; **enable-and-harden bulk
  import** (COPY spike + production object store + idempotency/content-hash) so `BULK_IMPORT_ENABLED` *can*
  be flipped per-tenant. Capacity panel is read-only.
- **Medium / Phase 1 (Validate, Dedup-Review, Enrich):** turn on the block-explosion **gate**; dedicated
  bulk lane concurrency caps + backpressure; worst-case spend pre-compute gate; add `data:manage` (DLQ
  replay, throttle) + `data:review`.
- **Medium / Phase 2 (Approve, Export, Self-Serve):** maker/checker on high-risk capacity actions
  (throttle interactive, replay retention DLQ); per-pipeline monitoring dashboards.
- **Enterprise / Phase 3+ (Govern & Scale):** SearchPort engine adapters (OpenSearch/Typesense); global ER
  scale track (Splink + DSU clustering over `master_persons`); SLOs + alerting + lineage; multi-region.

**Gating:** every new behaviour is flag- or capability-gated and rolls **shadow → canary → GA**. Block
instrumentation ships in *shadow* (measures, never rejects) first; the gate flips to *enforce* only after a
week of measured distributions confirms the 50M/100k ceilings fit real workspaces. Bulk lane caps roll to
one internal tenant (canary) before fleet GA. **Backfill:** none required for instrumentation; the chunk
lease columns (owned by 05) default safely (`attempts 0`, null lease) so in-flight jobs are unaffected.

---

## Success Metrics & Acceptance Criteria

A run is "done" when every box is testable and green:

- [ ] **AC1** Interactive read p95 **< 150 ms** under the 10× synthetic load; CI smoke fails the build on
      regression (the per-read latency floor).
- [ ] **AC2** `withTenantTx` RLS setup stays at **two round-trips**; a benchmark asserts no third.
- [ ] **AC3** Block-profiling runs before every dedup job and persists a `dedup_block_profiles` row;
      degenerate keys are rejected with `BlockExplosionError` and the offending key named.
- [ ] **AC4** A dedup run over a 1M-contact workspace completes via blocking (never all-pairs); measured
      candidate pairs < 50M and max bucket < 100k, or it is rejected pre-run.
- [ ] **AC5** COPY FROM STDIN verified against real Postgres on Bun; bulk import loads ≥ 100k rows/hour/worker
      into staging; `BULK_IMPORT_ENABLED` flippable per-tenant.
- [ ] **AC6** Bulk lane runs at ≤ 50% interactive concurrency; a 2M-row backfill soak causes **zero**
      interactive p95 breach.
- [ ] **AC7** DLQ replay is idempotent (second call `409`), audited via `withPlatformTx`, and gated by
      `data:manage` (+ JIT on high-risk queues).
- [ ] **AC8** Worst-case bulk enrichment spend is pre-computed and over-budget runs are refused
      (`ProviderBudgetExceededError` 429) before any spend.
- [ ] **AC9** Cross-tenant Data-Ops rollup uses a **single** `withPlatformTx` bounded by
      `PLATFORM_READ_LIMIT`, never a per-tenant `withTenantTx` loop.
- [ ] **AC10** Tenant-isolation itest proves workspace B cannot read workspace A's `dedup_block_profiles`
      row under RLS.
- [ ] **AC11** Capacity panel renders all four states (loading/empty/error/data) and reads RFC-7807 detail
      via `problemMessage`.
- [ ] **AC12** Every capacity write action (replay, throttle) writes a `platform_audit_log` row in the same
      transaction as the action.

---

> **Cross-links:** [01-Current-State-Analysis](./01-Current-State-Analysis.md) ·
> [02-Enterprise-Research](./02-Enterprise-Research.md) · [03-Gap-Analysis](./03-Gap-Analysis.md) ·
> [05-Upload-Pipeline-Design](./05-Upload-Pipeline-Design.md) ·
> [07-Deduplication-and-Linking](./07-Deduplication-and-Linking.md) ·
> [08-Data-Enrichment-Workflow](./08-Data-Enrichment-Workflow.md) ·
> [10-Monitoring-and-Observability](./10-Monitoring-and-Observability.md) ·
> [11-Roles-and-Permissions](./11-Roles-and-Permissions.md) ·
> [14-Implementation-Roadmap](./14-Implementation-Roadmap.md)
