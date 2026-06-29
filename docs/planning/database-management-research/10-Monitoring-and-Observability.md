# 10 — Monitoring & Observability

> **Series:** [Database Management](./README.md) · **Type:** Design · **Status:** ✅ Authored · **Prev:** [`09-Review-and-Approval-System`](./09-Review-and-Approval-System.md) · **Next:**
> [`11-Roles-and-Permissions`](./11-Roles-and-Permissions.md)

---

## 1. Objective

Today the only fleet-level operational surface is a single health screen that reports service
up/down plus the BullMQ depth of the bulk-enrichment lane ([`01` §5.10](./01-Current-State-Analysis.md#510-monitoring--observability--partial-one-health-screen-no-pipeline-depth);
[`features/system-health`](./04-Control-Panel-Architecture.md)). That is **Partial** — it answers
"is the platform up?" but not "how is each data pipeline behaving, for whom, at what cost, and is it
inside its SLO?". This document specifies the upgrade from **queue-depth-only** to **per-pipeline
observability** across the four data pipelines (import, enrichment, dedup/linking, retention), plus
the **fleet data-quality view** that is conspicuously missing today (customer-only quality exists;
no cross-tenant rollup).

Concretely, DOC 10 delivers:

- **Per-pipeline dashboards** — job-state distribution + record counts (created/matched/duplicate/
  rejected/deduped/charged) for import / enrichment / dedup / retention, drilling from fleet → tenant
  → workspace → single job.
- **Queue + DLQ health** — live depth, throughput, oldest-waiting age, failure rate and **DLQ size
  per `.dlq` partner**, with a guarded **DLQ replay** action.
- **Run-history drill-down** over the `*_jobs` ledgers (`import_jobs`, `enrichment_jobs`,
  `verification_jobs`, `retention_runs`) with their chunk/row children.
- **Fleet data-quality view** — the missing aggregate over `data_quality_snapshots` across tenants,
  with **per-dimension** sub-scores (accuracy / completeness / consistency / timeliness / validity /
  uniqueness) and **segment** breakdowns (size / geo / seniority), plus FP/FN against a labeled set,
  per-tier verification yield, and **dup-creation provenance**.
- **SLOs + alert thresholds** tied to `truepoint-platform` SLOs and `truepoint-operations` on-call.
- **Data lineage** — trace any overlay record back through `field_provenance` →
  `source_records` → `source_imports`.
- **Cost / FinOps trend** — `enrichment_jobs.cost_micros` rollups against provider monthly budgets
  and MTD spend.

This is a **read-mostly Surface-1 (internal staff console)** feature. It composes existing signals;
the only writes it introduces are (a) DLQ replay (re-enqueue, audited) and (b) alert-rule CRUD. It
builds **on top of** [`features/system-health`](./04-Control-Panel-Architecture.md) and
`apps/workers/src/register.ts:89`.

**Tier:** spans **MVP / Phase 0** (read-only Data-Ops Overview composing existing signals) →
**Medium / Phase 2** (per-pipeline dashboards) → **Enterprise / Phase 3+** (SLOs + alerting +
lineage). See [`14-Implementation-Roadmap`](./14-Implementation-Roadmap.md).

Cross-refs: [`04-Control-Panel-Architecture`](./04-Control-Panel-Architecture.md) (the nav group +
Data-Ops Overview this dashboard lives under), [`09-Review-and-Approval-System`](./09-Review-and-Approval-System.md)
(alerts on approval-queue backlog), [`13-Performance-and-Scaling`](./13-Performance-and-Scaling.md)
(the blocking/throughput numbers these dashboards visualize), [`11-Roles-and-Permissions`](./11-Roles-and-Permissions.md)
(the `data:read` gate), [`12-Security-and-Compliance`](./12-Security-and-Compliance.md) (no row
PII on ops surfaces).

---

## 2. Current Challenges

| # | Challenge | Evidence | Status |
|---|---|---|---|
| C1 | Monitoring is one screen reporting service up/down + **only** the bulk-enrichment queue depth/DLQ; the other 14+ queues have no surface. | `features/system-health` GET `/admin/system-health`; `apps/admin/src/features/system-health/api.ts:14` ("the bulk-enrichment job queue/DLQ summary") | Partial |
| C2 | No per-pipeline view. `import_jobs`, `enrichment_jobs`, `verification_jobs`, `retention_runs` carry rich counters but nothing aggregates them; the staff `features/imports` monitor is single-tenant metadata only, never tallied cross-fleet. | `schema/importJobs.ts`; `schema/enrichmentJobs.ts`; `schema/verificationJobs.ts`; `schema/retention.ts` | Missing |
| C3 | **No fleet data-quality view.** `data_quality_snapshots` is a daily per-workspace jsonb rollup but is surfaced **customer-only**; there is no cross-tenant aggregate ([`01` §5.9 / status: "data quality = Shipped customer-only (no fleet view)"]). | `schema/dataQualitySnapshots.ts` (migration 0031) | Missing |
| C4 | No DLQ visibility beyond one queue, and **no replay path**. A poisoned job sits in `*.dlq` invisibly; recovery is a manual Redis operation. | `register.ts` (`importDeadLetterQueue` `IMPORTS_DLQ` `:91`; every queue has a `.dlq` partner) | Missing |
| C5 | No SLOs, no alert thresholds, no on-call wiring. "Imports stuck for 2h" or "enrichment hit-rate fell off a cliff" is discovered by a customer ticket, not a page. | — | Missing |
| C6 | No lineage surface. `field_provenance` (per-field winner map), `source_records`, `source_imports` exist but there's no way to answer "where did this field come from / which import created these dupes?". | `contacts.field_provenance` (`schema/contacts.ts:103`); `source_records`, `source_imports` | Missing |
| C7 | No cost/FinOps trend. `enrichment_jobs` rows carry `cost_micros`/`charged`; provider budgets live in `provider-configs` (MTD spend), but there's no spend-over-time or per-tenant burn trend. | `schema/enrichmentJobs.ts`; `features/provider-configs` | Partial |
| C8 | No quality-of-resolution metrics: dedup match-rate, FP/FN vs a labeled set, per-tier verification yield, and **dup-creation provenance** (which source produces dupes) are uninstrumented. | `match_links.review_status`; `verification_jobs` | Missing |

The through-line: the **ledgers and rollups already exist** (the import/enrichment/verification/
retention `*_jobs` tables and `data_quality_snapshots`). The gap is **read-side aggregation,
cross-tenant rollup, and alerting** — not new write paths. That keeps DOC 10 low-risk: it is almost
entirely additive read surface behind a new `data:read` capability.

---

## 3. Enterprise Best Practices (cited)

From [`02-Enterprise-Research`](./02-Enterprise-Research.md), the governing dimensions for monitoring:

- **Dim 20 — Monitoring dashboards** ([`02` §dim-20](./02-Enterprise-Research.md#420-monitoring-dashboards)).
  Surface **job state + record counts**; **per-dimension quality metrics**; **segment match-rate /
  confidence by size / geo / seniority**; **FP/FN vs a labeled set**; **dup-creation provenance**;
  **per-tier verification yield** (Splink threshold tooling). This is the spine of §5.
- **Dim 11 — Audit logs / provenance** ([`02` §dim-11](./02-Enterprise-Research.md#411-audit-logs)).
  Attach **source/workflow provenance to every record** (enables root-cause tooling); **log match
  decisions**; **record match composition** (D&B MDP). Drives the lineage surface (§5.6).
- **Dim 21 — Operational tooling** ([`02` §dim-21](./02-Enterprise-Research.md#421-operational-tooling)).
  Build tools **over the audit/decision logs** (Apollo Duplicate Analyzer → root cause); a
  clerical-review console; **pre-flight cost + test-batch**. Our dup-creation provenance and
  cost-trend panels are exactly "tools over the decision log".
- **Dim 19 — Error handling** ([`02` §dim-19](./02-Enterprise-Research.md#419-error-handling)).
  **Never fail the whole batch**; per-record status array + **separate failed-results artifact** +
  echoed correlation token; idempotency keys replay the first response. Monitoring must surface the
  per-record failure artifact and the **DLQ** as first-class, and DLQ replay must be **idempotent**.
- **Dim 10 — Quality scoring** ([`02` §dim-10](./02-Enterprise-Research.md#410-quality-scoring)).
  **Per-dimension sub-scores** (accuracy / completeness / consistency / timeliness / validity /
  uniqueness); **last-updated recency** is the top signal; numeric confidence, not boolean. The
  fleet quality view renders these six dimensions, not a single number.
- **Dim 14 — Data governance / segment SLAs** ([`02` §dim-14](./02-Enterprise-Research.md#414-data-governance)).
  **Segment quality SLAs by size/geo/seniority — no single global match number.** The fleet view's
  segment breakdown and the SLO definitions follow this directly.
- **Dim 18 — Queue management** ([`02` §dim-18](./02-Enterprise-Research.md#418-queue-management)).
  Dedicated **bulk lane below interactive**; multi-window limits + **quota/reset headers + 429**;
  anticipate parent-lock contention. The queue panel must show per-lane depth and flag the bulk lane
  separately; the alert engine watches the bulk lane's backlog independently.
- **Dim 22 / 23 — Scalability / Performance** ([`02` §dim-22](./02-Enterprise-Research.md#422-scalability-strategies)).
  Blocking is load-bearing; **dedupe before enrichment**; **re-verify on access/incremental**.
  These define which *throughput* metrics matter (blocking key cardinality, dedup-before-enrich
  ordering) — see [`13`](./13-Performance-and-Scaling.md).

`truepoint-platform` (SLO ownership + observability) and `truepoint-operations` (incident
classification, on-call, FinOps) are the precedence owners for §5.5 and §5.7. Security
([`12`](./12-Security-and-Compliance.md)) has final say that **no row-level PII** ever appears on an
ops dashboard — counts and provenance metadata only, mirroring the `features/imports` "metadata +
tallies only, never row contents" rule.

---

## 4. Gaps in Current Implementation

Mapped to [`03-Gap-Analysis`](./03-Gap-Analysis.md) and [`01-Current-State-Analysis`](./01-Current-State-Analysis.md):

| Gap | What exists | What's missing | Tier |
|---|---|---|---|
| **G-MON-1** Pipeline dashboards | `*_jobs` ledgers with counters; system-health one screen | Cross-pipeline state + record-count rollups; fleet→tenant→ws drill | **Phase 0** (overview, read-only) → **Phase 2** (full per-pipeline) |
| **G-MON-2** Queue/DLQ health | bulk-enrichment depth/DLQ in system-health; every queue has a `.dlq` | All-lane depth/throughput/age; DLQ size per partner; guarded **replay** | **Phase 0** (read) → **Phase 1** (replay) |
| **G-MON-3** Run-history drill | `features/imports` single-tenant monitor | Cross-tenant run history over all four ledgers + chunk/row drill | **Phase 0/1** |
| **G-MON-4** Fleet quality view | `data_quality_snapshots` customer-only | Cross-tenant aggregate + per-dimension + segment + FP/FN + verification yield + dup provenance | **Phase 2** |
| **G-MON-5** SLOs + alerting | none | SLO definitions + threshold alert engine + on-call routing | **Phase 3+** |
| **G-MON-6** Lineage | `field_provenance`, `source_records`, `source_imports` | A lineage drill that joins them | **Phase 3+** |
| **G-MON-7** Cost/FinOps trend | `cost_micros`, provider MTD spend | Spend-over-time, per-tenant burn, budget-burndown | **Phase 2** |

The Data-Ops Overview tile-row in [`04` §Data-Ops Overview](./04-Control-Panel-Architecture.md) is the
**Phase-0** slice of this doc: it composes existing signals (system-health queue depth + import/
enrichment/retention run tallies + aggregated `data_quality_snapshots`) with **no new writes**. DOC 10
then deepens each tile into a pipeline dashboard.

---

## 5. Recommended Solution

A new **Monitoring** sub-area inside the `apps/admin` **Data management** nav group ([`04`](./04-Control-Panel-Architecture.md)),
implemented as a feature folder `features/data-monitoring/` following the `features/imports` +
`features/retention` templates (barrel `index.ts`, single network seam `api.ts`, presentation
`types.ts`, hand-rolled `hooks/use*.ts` returning `{data, loading, error, reload}`, components under
`components/`). Backend is a new read-mostly router `apps/api/src/features/admin/data/monitoring/`
mounted at `/api/v1/admin/data/monitoring/*`, gated by `platformAdmin` + `requireCapability("data:read")`,
reading cross-tenant via `withPlatformTx` (audited; owner connection; BYPASSRLS) — the **only**
sanctioned cross-tenant read path. DLQ replay and alert-rule CRUD are the only writes and require
`data:manage`.

### 5.1 Per-pipeline dashboards (status: **Planned**)

Four pipeline cards, each a normalized view of its `*_jobs` ledger:

| Pipeline | Source ledger | State machine | Record counters surfaced |
|---|---|---|---|
| **Import** | `import_jobs` (+ `_chunks`, `_rows`) | `queued→validating→staged→running→paused→completed/partial/failed/cancelled` | created / matched / duplicate / skipped / rejected / deduped / unprocessed; `av_scan_status` |
| **Enrichment** | `enrichment_jobs` (+ `_chunks`, `_rows`) | queued→running→completed/partial/failed | rows enriched, `match_outcome` tally, `cost_micros` sum, `charged` count, `email_status` mix |
| **Dedup / Linking** | `dedup` queue + `match_links` | n/a (worker) | clusters formed, `is_duplicate_of` survivor count, `review_status` queue depth (auto/pending/confirmed/rejected) |
| **Retention** | `retention_runs` (+ `retention_class_policies`) | per-tenant run | shadow-counted vs deleted by class; mode (disabled/shadow/enforce) |

Each card shows: a **state-distribution bar** (jobs by status over a window), **record-count
sparkline**, **error rate**, **oldest in-flight age**, and a **throughput** number (rows/min). Click
→ run-history list → single-job drill (§7).

### 5.2 Queue + DLQ health (status: **Planned**)

Read live BullMQ metrics for every queue registered in `register.ts:89` (the producers) — `imports`,
`bulk-imports` (dark), `enrichment`, `dedup`, `firmographics`, `master-backfill(+sweep)`,
`reverification(+sweep)`, `data-quality-snapshot-sweep`, `data-retention-sweep`, `scoring`, `dsar`,
`outreach`, `email-sequence-tick`, `email-token-refresh` — plus each `.dlq` partner
(`IMPORTS_DLQ`, `BULK_IMPORTS_DLQ`, …). Per queue: `waiting`, `active`, `delayed`, `completed`,
`failed`, **DLQ size**, oldest-waiting age, throughput. The **bulk lane** is flagged separately per
Dim 18 (it runs below interactive). **DLQ replay** (`data:manage`): select DLQ entries → re-enqueue
onto the live queue; idempotent (the job's own `idempotency_key` / `content_hash` guards dedupe a
double-replay — Dim 19); audited via `withPlatformTx` writing `platform_audit_log`.

### 5.3 Run-history drill-down (status: **Planned**)

Keyset-paginated list over each ledger (never offset; `packages/types/src/search.ts` cursor
contract). Filters: tenant, workspace, status, date window, `idempotency_key`. Single-job drill joins
the `*_chunks` / `*_rows` children to show per-chunk progress and the **per-row failure artifact**
(reject reason codes — **never row PII**, Dim 19/Security). Mirrors `features/imports` drill but
cross-tenant and across all four pipelines.

### 5.4 Fleet data-quality view (the missing view) (status: **Planned**)

Aggregate `data_quality_snapshots` (daily per-ws jsonb rollup) **across tenants**. Renders:

- **Per-dimension sub-scores** (Dim 10): accuracy / completeness / consistency / timeliness /
  validity / uniqueness — six gauges, fleet-wide and per-tenant, with trend.
- **Segment breakdown** (Dim 14/20): match-rate + mean confidence by **company size / geo /
  seniority** — explicitly **no single global number**.
- **FP/FN vs a labeled set** (Dim 20): against a curated golden/labeled sample (a new
  `quality_label_set` — §8), compute false-positive / false-negative dedup/match rates.
- **Per-tier verification yield** (Dim 20): for `email_status` / `phone_status` tiers
  (valid/risky/invalid/catch_all/unknown), the yield % each verification run produced — the
  decision input for graduating verification out of **Dark**.
- **Dup-creation provenance** (Dim 5/20): which `source_imports` produced the most
  `duplicate_of_contact_id` links — "~90% of dupes came from CRM imports" made visible.

A nightly **materialized rollup** (`fleet_quality_daily`, §8) feeds this so the dashboard never scans
`data_quality_snapshots` live across the fleet.

### 5.5 SLOs + alert thresholds (status: **Planned**; owner: truepoint-platform + truepoint-operations)

Define SLOs and back them with a threshold alert engine (sweep-evaluated). Initial SLO set:

| SLO | Target | Alert threshold | Routes to |
|---|---|---|---|
| Import job completion latency (p95, std import) | < 5 min for ≤100k rows | p95 > 15 min OR any job `running` > 2h | on-call (warn) |
| Import error rate | < 2% rejected | > 10% rejected on a job | on-call (warn) |
| Enrichment hit-rate | ≥ baseline − 10pts | drop > 15pts vs 7-day mean | data-team (warn) |
| Queue oldest-waiting age | < 2 min interactive / < 30 min bulk | > 10 min interactive / > 2h bulk | on-call (page if interactive) |
| DLQ size (any partner) | 0 | > 0 sustained 15 min; > 50 → page | on-call |
| Verification yield drop | stable | > 20% drop tier-over-tier | data-team |
| Provider budget burn | < 90% MTD | ≥ 90% MTD → warn; ≥ 100% → the `ProviderBudgetExceededError` 429 path already fires | FinOps |
| Retention enforce delta | shadow≈enforce | enforce would delete > 2× shadow estimate → **block + page** | on-call + compliance |

Alerts tie to the **flip events** in [`09`](./09-Review-and-Approval-System.md) and
[`14`](./14-Implementation-Roadmap.md): flipping `retention_engine_enabled` / a class to `enforce`,
or enabling `BULK_IMPORT_ENABLED`, **arms** the corresponding canary alerts (e.g. retention enforce
delta, bulk-lane backlog). Alert severity maps to `truepoint-operations` incident classes; paging
goes through the existing on-call channel. SLO targets are owned by `truepoint-platform`.

### 5.6 Data lineage (status: **Planned**)

A lineage drill for any overlay record (contact/account): read `field_provenance` (per-field
source/confidence winner map) → resolve the `source_records` rows it points at → resolve their
parent `source_imports`. Renders a per-field table: field → winning source → confidence → import job
→ ingested-at. This is **Layer-0/Layer-1 spanning** so it reads master-graph context via `withErTx`
where needed and overlay via `withPlatformTx`; it shows **provenance metadata only**, never PII
field values (Security/§12). Implements Dim 11.

### 5.7 Cost / FinOps trend (status: **Partial → Planned**)

Roll up `enrichment_jobs.cost_micros` (and `enrichment_job_rows.cost_micros`, `charged`) by day,
tenant, provider, and `match_method`. Render: fleet spend trend, per-tenant burn, **budget
burn-down** against each provider's monthly budget (from `provider-configs`), and a "charge-only-on-
success" integrity check (charged rows should ≈ successful `match_outcome`). Owned by
`truepoint-operations` FinOps. Feeds the budget-burn alert in §5.5.

---

## 6. Implementation Steps (sequenced)

1. **Capability + gate (Phase 0).** Add `data:read` to `packages/types/src/staffCapability.ts:13`
   (closed enum → 17 (one of four total data:* additions; enum reaches 20 — see [`11-Roles-and-Permissions`](./11-Roles-and-Permissions.md))), bundle it into `ROLE_CAPABILITIES` for `super_admin` (implied) + `support` +
   add a read-only grant; `data:manage` for replay/alerts (Phase 1). See [`11`](./11-Roles-and-Permissions.md).
2. **Backend read router (Phase 0).** `apps/api/src/features/admin/data/monitoring/routes.ts`
   mounted under `routes.ts` admin tree at `/api/v1/admin/data/monitoring/*`; all reads via
   `withPlatformTx(actor, "data.monitoring.read", …)`. Endpoints §9.1–9.6.
3. **Data-Ops Overview tile-row (Phase 0).** Compose system-health + ledger tallies + the fleet-
   quality rollup into the overview ([`04`](./04-Control-Panel-Architecture.md)). No new writes.
4. **Queue/DLQ panel + replay (Phase 0 read / Phase 1 write).** Read BullMQ via a worker-side
   metrics endpoint or direct queue inspection in api; add `POST …/queues/:queue/dlq/replay`
   (`data:manage`, audited, idempotent).
5. **Run-history drill (Phase 1).** Keyset list + single-job drill over the four ledgers.
6. **Fleet quality materialization (Phase 2).** Migration ~`0035` adds `fleet_quality_daily`
   matview + a refresh in the existing `data-quality-snapshot-sweep` (daily). Then the fleet
   quality dashboard.
7. **Cost/FinOps trend (Phase 2).** `enrichment_jobs` rollup endpoint + panel.
8. **SLO + alert engine (Phase 3+).** Migration adds `slo_alert_rules` + `slo_alert_events`; a new
   `slo-eval-sweep` queue (leader-locked) evaluates rules each minute and writes events; wire
   on-call routing. Arm canary alerts on the [`09`](./09-Review-and-Approval-System.md)/[`14`](./14-Implementation-Roadmap.md) flips.
9. **Lineage drill (Phase 3+).** `field_provenance`→`source_records`→`source_imports` join endpoint.
10. **Tests at each step** (§11), including the mandatory tenant-isolation test for every write
    (DLQ replay, alert-rule CRUD).

---

## 7. UI/UX Requirements

Lives under `apps/admin` Data management → **Monitoring**. Two screens: the **Ops Dashboard** and the
**Single-Job Drill**. Built from `@leadwolf/ui` only; tokens `var(--tp-*)`; four states via
`StateSwitch` (loading `LoadingState`/`Skeleton`, empty `EmptyState`, error `ErrorState`, data).

**Components used:** `StateSwitch`, `StatTile` (queue depth / DLQ / hit-rate / spend tiles),
`Card`, `DataTable`+`Column<T>` (run history; `sortValue`, `rowKey`), `StatusBadge`+`StatusTone`
(job state → tone: completed=success, partial=warning, failed=danger, running=info), `Tabs`
(Pipelines | Queues | Quality | Cost | Alerts), `SegmentedControl` (time window 1h/24h/7d/30d),
`Combobox` (tenant/workspace/provider filter), `Pagination` (keyset), `Drawer` (single-job drill),
`Tooltip` (metric definitions), `TpButton` (DLQ replay → `Dialog` confirm with mandatory
justification reason per the `TenantActions` JIT pattern), `ToastProvider/useToast` (replay result),
`Icon`. **No row PII renders anywhere** — counts, codes, provenance metadata only.

### 7.1 Ops Dashboard (ASCII)

```
┌─ Data management ▸ Monitoring ───────────────────────────────[ 24h ▾ ][⟳]┐
│ [ Pipelines ] [ Queues ] [ Quality ] [ Cost ] [ Alerts ]   filter:[tenant ▾]│
├──────────────────────────────────────────────────────────────────────────┤
│ ┌Import──────────┐ ┌Enrichment──────┐ ┌Dedup/Link──────┐ ┌Retention──────┐│
│ │ run 1,204  ●12 │ │ run 856  ●3    │ │ clusters 4,901 │ │ runs 30 shadow││
│ │ rej 2.1%  err● │ │ hit 71% ↓4pts  │ │ pending review │ │ would-del 812 ││
│ │ ▁▂▅▇▆▃ rows/min│ │ $ 42.1k MTD    │ │ 137  ⚠ SLA     │ │ enforce: OFF  ││
│ └────────────────┘ └────────────────┘ └────────────────┘ └───────────────┘│
├─ Queues & DLQ ────────────────────────────────────────────────────────────┤
│ queue            wait act delay fail  DLQ  oldest  thru   [lane]           │
│ imports            18   4    0    1     0   42s    320/m  interactive      │
│ bulk-imports        0   0    0    0     0    –       –     bulk (dark)      │
│ enrichment          6   8    2    0     3 ⚠ 6m12s   90/m  bulk   [Replay…] │
│ dedup               2   1    0    0     0   11s    410/m  interactive      │
│ reverification      0   0    0    0     0    –       –     bulk             │
│ data-retention-…    0   0    0    0     0    –       –     scheduled        │
├─ Active SLO alerts ───────────────────────────────────────────────────────┤
│ ⚠ enrichment hit-rate dropped 4pts (warn)        ⚠ enrichment DLQ=3 (warn) │
└──────────────────────────────────────────────────────────────────────────┘
```

### 7.2 Single-Job Drill (Drawer, ASCII)

```
┌─ Import job  ij_8f3a…  ▸  acme-corp / ws_main ──────────────────────[ ✕ ]┐
│ status [ partial ●warn ]   idempotency_key da39…   av_scan: clean         │
│ created 12:04  staged 12:05  running 12:05–12:11  → completed(partial)    │
├─ Record counts ──────────────────────────────────────────────────────────┤
│ created 8,140 · matched 1,902 · duplicate 412 · skipped 33 · rejected 219 │
│ deduped 96 · unprocessed 0                                                 │
├─ Chunks (12) ─────────────────────────────────────────────────────────────┤
│ #  rows   done   rejected   status                                        │
│ 1  1000   1000      4       completed                                     │
│ 7  1000    981     19       partial   ▸ view reject codes                 │
│ …                                                                          │
├─ Reject reasons (no row contents) ────────────────────────────────────────┤
│ MISSING_REQUIRED:118 · BAD_EMAIL_FORMAT:71 · DUP_IN_FILE:30               │
├─ Lineage ▸ field_provenance → source_records → source_imports ────────────┤
│ email     ← source_import si_44 (CRM/Salesforce)  conf 0.92  12:04        │
│ title     ← enrichment (provider X)               conf 0.81  12:08        │
└──────────────────────────────────────────────────────────────────────────┘
```

### 7.3 Four states

- **Loading:** `StateSwitch`→`LoadingState`; tiles render `Skeleton` placeholders; never block the
  shell.
- **Empty:** `EmptyState` ("No jobs in this window") with a window-widen CTA; quality view empty
  when no snapshots yet.
- **Error:** `ErrorState` reading the RFC-7807 `detail`/`title` via the `problemMessage(res, fallback)`
  helper; `reload()` from the hook.
- **Data:** the dashboards above; auto-refresh on a polite interval (hand-rolled `useEffect`
  setInterval in the hook, paused when tab hidden — **no TanStack/React Query**).

---

## 8. Database & Backend Changes

**Reused, unchanged (read-only):** `import_jobs` / `import_job_chunks` / `import_job_rows`
(`schema/importJobs.ts`, migration 0032); `enrichment_jobs` / `_chunks` / `_rows`
(`schema/enrichmentJobs.ts`); `verification_jobs` (`schema/verificationJobs.ts`, migration 0030);
`data_quality_snapshots` (`schema/dataQualitySnapshots.ts`, migration 0031); `retention_runs` /
`retention_class_policies` (`schema/retention.ts`, migration 0033); `match_links`; `contacts.field_provenance`
+ `source_records` + `source_imports` (lineage); `platform_audit_log` (written by `withPlatformTx`);
`audit_log` (`schema/billing.ts:169`). All reads use **`withPlatformTx`** (audited owner connection,
BYPASSRLS, writes a `platform_audit_log` row in-tx) except lineage's master-graph hop which uses
**`withErTx`** (role `leadwolf_er`, master-graph read, no overlay grant). **No RLS posture change** —
these are system-owned cross-tenant reads, not tenant-scoped paths.

**New (migration ~`0035`+, slugged per `drizzle.config.ts`):**

```sql
-- the next sequential migration (0035+) — fleet_quality_daily
-- Cross-tenant materialized rollup of data_quality_snapshots for the fleet view.
-- Refreshed by the daily data-quality-snapshot-sweep (leader-locked). System-owned, NOT RLS-scoped.
CREATE MATERIALIZED VIEW fleet_quality_daily AS
SELECT
  dqs.snapshot_date,
  dqs.tenant_id,
  dqs.workspace_id,
  (dqs.metrics ->> 'accuracy')::numeric      AS accuracy,
  (dqs.metrics ->> 'completeness')::numeric  AS completeness,
  (dqs.metrics ->> 'consistency')::numeric   AS consistency,
  (dqs.metrics ->> 'timeliness')::numeric    AS timeliness,
  (dqs.metrics ->> 'validity')::numeric      AS validity,
  (dqs.metrics ->> 'uniqueness')::numeric    AS uniqueness,
  (dqs.metrics -> 'segments')                AS segments,   -- {size,geo,seniority} sub-rollups
  (dqs.metrics -> 'verification_yield')      AS verification_yield
FROM data_quality_snapshots dqs;

CREATE UNIQUE INDEX uniq_fleet_quality_daily
  ON fleet_quality_daily (snapshot_date, tenant_id, workspace_id);  -- enables REFRESH … CONCURRENTLY

-- 0035 (cont.) — labeled golden set for FP/FN measurement (Dim 20). System-owned.
CREATE TABLE quality_label_set (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label_kind    text NOT NULL,                 -- 'dedup_pair' | 'match_link' | 'verification'
  left_ref      uuid NOT NULL,                 -- record / cluster reference (metadata only, no PII)
  right_ref     uuid,
  expected      text NOT NULL,                 -- 'match' | 'no_match' | 'valid' | 'invalid'
  labeled_by    uuid NOT NULL,                 -- platform_staff actor
  labeled_at    timestamptz NOT NULL DEFAULT now(),
  notes         text
);
CREATE INDEX idx_quality_label_set_kind ON quality_label_set (label_kind);

-- 0036_slo_alerts.sql (Phase 3+) — alert rules + fired events. System-owned, audited via withPlatformTx.
CREATE TABLE slo_alert_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_key    text NOT NULL,                 -- 'import.error_rate' | 'queue.oldest_age' | 'dlq.size' | …
  scope         text NOT NULL DEFAULT 'fleet', -- 'fleet' | 'tenant' | 'queue'
  scope_ref     text,                          -- tenant_id / queue name when scoped
  comparator    text NOT NULL,                 -- 'gt' | 'lt'
  threshold     numeric NOT NULL,
  window_secs   integer NOT NULL DEFAULT 900,
  severity      text NOT NULL,                 -- 'warn' | 'page'
  armed         boolean NOT NULL DEFAULT true, -- flip-armed canaries (09/14)
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE slo_alert_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id       uuid NOT NULL REFERENCES slo_alert_rules(id),
  observed      numeric NOT NULL,
  fired_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  notified      boolean NOT NULL DEFAULT false
);
CREATE INDEX idx_slo_alert_events_open ON slo_alert_events (rule_id, fired_at) WHERE resolved_at IS NULL;
```

**Refresh wiring:** extend the existing `data-quality-snapshot-sweep` (daily, leader-locked via
`leaderLock.ts`) to `REFRESH MATERIALIZED VIEW CONCURRENTLY fleet_quality_daily` after snapshots are
written. **No new heavy scan on the request path.** The Phase-3 `slo-eval-sweep` queue (new
`.dlq` partner per convention, leader-locked) evaluates `slo_alert_rules` each minute, writing
`slo_alert_events` and emitting on-call notifications.

**Queue metrics** are read live from BullMQ (no DB). The api gets queue handles or calls a small
worker-exposed metrics endpoint; either way the figures are ephemeral and never persisted.

---

## 9. API Requirements

Base: `/api/v1/admin/data/monitoring`. Gate on **all**: `authn` (Bearer) → `platformAdmin`
(`claims.pa===true`) → `requireStaffRole` (active role resolved per-request) → `requireCapability`.
Reads carry `data:read`; writes carry `data:manage`. RFC 9457 problem envelope
(`middleware/error.ts`). Keyset pagination per `packages/types/src/search.ts` (cursor, limit 1..200
default 50 → `nextCursor`). Request bodies parsed with `safeParse` at the edge; responses re-validated
with `parse`. **Scope is never read from the body** — tenant/workspace filters are explicit query
params validated against the actor's cross-tenant `data:read` grant, and the read itself runs inside
`withPlatformTx` (audited).

### 9.1 Pipeline summaries
```
GET  /pipelines/summary?window=24h
  → 200 { pipelines: { import|enrichment|dedup|retention: {
            stateCounts: Record<JobState, number>,
            records: { created, matched, duplicate, skipped, rejected, deduped, unprocessed },
            errorRate: number, throughputPerMin: number, oldestInFlightSecs: number|null } } }
  gate: data:read   pagination: n/a   idempotency: n/a
```

### 9.2 Run history (per pipeline)
```
GET  /pipelines/:pipeline/runs?tenantId=&workspaceId=&status=&cursor=&limit=
  pipeline ∈ {import,enrichment,verification,retention}
  → 200 { runs: RunSummary[], nextCursor: string|null }
  RunSummary = { jobId, tenantId, workspaceId, status, counts:{…}, startedAt, finishedAt, idempotencyKey }
  errors: ValidationError 422 (bad pipeline/cursor)
  gate: data:read   pagination: keyset
```

### 9.3 Single-job drill
```
GET  /pipelines/:pipeline/runs/:jobId
  → 200 { job: RunSummary, chunks: ChunkRow[], rejectCodes: Record<string, number>, lineageAvailable: boolean }
  errors: NotFoundError (unknown jobId)
  gate: data:read     NOTE: returns reject CODE tallies only, never row PII (§12)
```

### 9.4 Queue + DLQ health, and replay
```
GET  /queues
  → 200 { queues: { name, waiting, active, delayed, completed, failed, dlqSize, oldestWaitingSecs, throughputPerMin, lane }[] }
  gate: data:read

POST /queues/:queue/dlq/replay
  headers: Idempotency-Key (required)
  body: { jobIds: string[], reason: string (min 8) }      // mandatory justification (JIT pattern)
  → 202 { requeued: number, skipped: number }
  errors: ValidationError 422 (empty jobIds / missing reason), NotFoundError (unknown queue),
          ForbiddenError (missing data:manage)
  gate: data:manage   idempotency: Idempotency-Key replays first response (Dim 19);
        underlying job idempotency_key/content_hash dedupes a double-replay
        AUDIT: writes platform_audit_log in-tx via withPlatformTx (action data.dlq.replay)
```

### 9.5 Fleet data-quality
```
GET  /quality/fleet?window=30d&segment=size|geo|seniority
  → 200 { dimensions: { accuracy, completeness, consistency, timeliness, validity, uniqueness }[],
          segments: { key, matchRate, meanConfidence }[],
          falsePositiveRate: number, falseNegativeRate: number,
          verificationYield: { tier, yieldPct }[],
          dupProvenance: { sourceImportId, dupCount }[] }
  source: fleet_quality_daily matview + quality_label_set
  gate: data:read
```

### 9.6 Cost / FinOps trend
```
GET  /cost/trend?groupBy=day|tenant|provider&window=30d
  → 200 { series: { key, costMicros, chargedRows, successRows }[],
          budgets: { provider, monthlyBudgetMicros, mtdSpendMicros, burnPct }[] }
  gate: data:read
```

### 9.7 Lineage (Phase 3+)
```
GET  /lineage/:entity/:id        entity ∈ {contact, account}
  → 200 { fields: { field, sourceKind, sourceImportId, confidence, ingestedAt }[] }
  errors: NotFoundError
  gate: data:read   NOTE: provenance metadata only, never field VALUES (§12)
```

### 9.8 Alert rules (Phase 3+)
```
GET  /alerts/rules                          → 200 { rules: AlertRule[] }            gate: data:read
POST /alerts/rules    body: AlertRuleInput  → 201 { rule }   Idempotency-Key        gate: data:manage  (audited)
GET  /alerts/events?status=open&cursor=     → 200 { events, nextCursor }            gate: data:read
```

---

## 10. Edge Cases & Failure Scenarios

1. **DLQ replay double-fire.** Two staff replay the same DLQ entry. Idempotency-Key replays the first
   response for an exact retry; for distinct requests, the **job's own** `idempotency_key`/
   `content_hash` makes the re-enqueue a no-op at the worker. Net: never double-processed (Dim 19).
2. **Replay onto a dark/disabled queue.** Replaying into `bulk-imports` while `BULK_IMPORT_ENABLED=false`:
   reject with `ValidationError` ("queue disabled") — don't enqueue work nothing will consume.
3. **Matview staleness.** `fleet_quality_daily` is at most ~24h old. The UI stamps "as of
   <snapshot_date>". Live-truth questions route to the per-job drill, not the fleet rollup.
4. **REFRESH CONCURRENTLY contention.** Requires the unique index (present) and won't block reads;
   if the sweep is mid-refresh, the dashboard serves the prior generation. A failed refresh leaves
   the last good generation intact and emits an ops warning.
5. **Empty labeled set.** FP/FN rates show "insufficient labels (<N)" rather than a misleading 0%.
6. **Tenant deleted / workspace purged.** Run-history rows for a purged workspace show
   tenant=`(deleted)`; lineage to purged `source_records` shows "source removed (DSAR)". No PII
   resurfaces from tombstoned data.
7. **Queue metrics unavailable** (Redis blip). Queue panel renders `ErrorState` for that section
   only; pipeline cards (DB-sourced) still render — partial failure never blanks the dashboard.
8. **Clock skew on throughput.** Throughput uses job timestamps from the DB (single clock), not
   worker wall-clock, avoiding negative rates.
9. **Cost integrity mismatch.** `charged` rows ≫ successful `match_outcome` → flag a billing-integrity
   anomaly (over-charge risk) to FinOps; this is a correctness alert, not cosmetic.
10. **Retention enforce delta spike.** If an armed enforce-canary sees would-delete ≫ shadow estimate,
    the alert **blocks** the flip and pages compliance ([`09`](./09-Review-and-Approval-System.md)/[`12`](./12-Security-and-Compliance.md)) — fail-closed on deletion.
11. **Cross-tenant read without grant.** A `support` staffer without `data:read` → `ForbiddenError`
    403 at `requireCapability`; the probe never reaches `withPlatformTx`.
12. **Large run-history window.** A 30d × fleet query is keyset-paginated and indexed; no offset, no
    unbounded scan ([`13`](./13-Performance-and-Scaling.md)).
13. **PII leak via reject artifact.** Reject endpoint returns **code tallies** only; a row-content
    field in the artifact is a Security bug, blocked in review and asserted in tests (§11).

---

## 11. Testing Strategy

**Unit:** matview projection (jsonb → dimension columns); throughput/error-rate math; alert-rule
comparator evaluation (gt/lt, window); cost-integrity check; segment bucketing (size/geo/seniority).

**Integration (api, in-process):** each endpoint behind the full gate stack
(`authn`→`platformAdmin`→`requireStaffRole`→`requireCapability`); 403 without `data:read`/`data:manage`;
RFC-7807 envelopes for `ValidationError`/`NotFoundError`/`ForbiddenError`; keyset cursor correctness
(stable order, `nextCursor` round-trip); Idempotency-Key replay on DLQ replay returns the first
response; **audit assertion** — every DLQ replay and alert-rule write produces exactly one
`platform_audit_log` row in the same tx (`withPlatformTx`).

**itest (with Postgres):** matview refresh + `REFRESH … CONCURRENTLY` against the unique index;
fleet aggregate across ≥2 tenants returns correctly partitioned per-dimension scores; lineage join
`field_provenance`→`source_records`→`source_imports`.

**Mandatory tenant-isolation test (writes):** DLQ replay and alert-rule CRUD are cross-tenant
system-owned writes — assert (a) they are reachable **only** through `withPlatformTx` (owner conn,
audited), never `withTenantTx`; (b) a non-`pa` token is rejected at `platformAdmin` before any DB
touch; (c) the audited row records actor + reason + target. **PII-leakage test:** the reject-codes
and lineage endpoints return **no row field values** — assert response shapes contain only
codes/metadata. Per CLAUDE.md, a multi-tenant write without an RLS-enforced/ownership-checked/audited
path is a bug — here the "ownership" boundary is the verified `pa` claim + `data:manage` capability,
and the audit is `withPlatformTx`.

---

## 12. Rollout & Migration Plan

| Stage | Gate | Scope |
|---|---|---|
| **Phase 0** | ship `data:read`; Data-Ops Overview + read-only pipeline/queue panels | compose existing signals, **no writes** |
| **Phase 1** | ship `data:manage`; DLQ replay + run-history drill | replay behind audited `withPlatformTx` + Idempotency-Key |
| **Phase 2** | migration `0035` (`fleet_quality_daily`, `quality_label_set`); fleet quality + cost trend | matview refresh added to existing daily sweep |
| **Phase 3+** | migration `0036` (`slo_alert_rules`/`_events`); `slo-eval-sweep` queue; lineage drill | alerts **shadow → canary → GA**: rules land `armed=false`, observe fired events vs reality, then arm |

**Capability rollout:** new caps are additive to the **closed** `staffCapability` enum; `super_admin`
implies all immediately; grant `data:read` to `support`/`read_only` read bundles, `data:manage` to a
narrow set ([`11`](./11-Roles-and-Permissions.md)). Revocation is immediate via `requireStaffRole`
(no stale-JWT window).

**Backfill:** none required for reads — the ledgers and snapshots already exist. The matview's
first `REFRESH` populates the fleet view from historical `data_quality_snapshots` on first sweep.

**Alert arming ties to flips (09/14):** SLO rules ship `armed=false` and **shadow** (fire events,
no page) for ≥1 week. Arming the retention-enforce-delta and bulk-lane-backlog canaries is gated on
the corresponding flip in [`14`](./14-Implementation-Roadmap.md): flipping a retention class to
`enforce` or enabling `BULK_IMPORT_ENABLED` arms its canary in the same change. SLO targets are
owned by `truepoint-platform`; paging routes through `truepoint-operations` on-call.

---

## 13. Success Metrics & Acceptance Criteria

**Outcome metrics:** MTTR for a stuck pipeline drops (detected by alert, not ticket); DLQ time-to-
empty < 1h; fleet quality-dimension trend visible to staff; provider budget overruns caught at 90%
burn, not at the 429.

**Acceptance criteria (testable checklist):**

- [ ] A `data:read` staffer sees the Monitoring dashboard with all four pipeline cards populated from
      `import_jobs`/`enrichment_jobs`/`verification_jobs`/`retention_runs`.
- [ ] A staffer **without** `data:read` gets 403 (`ForbiddenError`) at `requireCapability` before any
      DB read.
- [ ] The queue panel lists **every** queue in `register.ts:89` plus each `.dlq` partner with live
      depth and DLQ size; the bulk lane is flagged distinctly.
- [ ] DLQ replay requires `data:manage` + Idempotency-Key + a justification reason (≥8 chars), is
      idempotent, and writes exactly one `platform_audit_log` row in-tx via `withPlatformTx`.
- [ ] Single-job drill shows state timeline + record counts + chunk rows + reject-**code** tallies,
      with **no row PII**.
- [ ] The fleet quality view aggregates `data_quality_snapshots` across ≥2 tenants and renders all
      six per-dimension sub-scores plus size/geo/seniority segment breakdowns (Dim 10/14/20).
- [ ] FP/FN rates compute against `quality_label_set`; "insufficient labels" shown when below
      threshold.
- [ ] Per-tier verification yield and dup-creation provenance (by `source_imports`) render.
- [ ] Cost trend rolls `cost_micros` by day/tenant/provider and shows budget burn-down; a
      charged-vs-success mismatch raises a FinOps anomaly.
- [ ] `fleet_quality_daily` is refreshed by the existing daily sweep (leader-locked), `CONCURRENTLY`,
      with the unique index present; the dashboard never live-scans the fleet on the request path.
- [ ] SLO alert rules evaluate on the `slo-eval-sweep`; events write to `slo_alert_events`; arming
      the retention-enforce and bulk-lane canaries is coupled to the [`14`](./14-Implementation-Roadmap.md) flips.
- [ ] All endpoints use keyset pagination (no offset), RFC-9457 envelopes, edge `safeParse` +
      response `parse`, and read scope only from validated params inside `withPlatformTx`.
- [ ] Tenant-isolation + PII-leak tests pass: cross-tenant writes only via `withPlatformTx`; reject/
      lineage endpoints return metadata only.

---

### Cross-references
[`01-Current-State-Analysis`](./01-Current-State-Analysis.md) ·
[`02-Enterprise-Research`](./02-Enterprise-Research.md) ·
[`03-Gap-Analysis`](./03-Gap-Analysis.md) ·
[`04-Control-Panel-Architecture`](./04-Control-Panel-Architecture.md) ·
[`05-Upload-Pipeline-Design`](./05-Upload-Pipeline-Design.md) ·
[`08-Data-Enrichment-Workflow`](./08-Data-Enrichment-Workflow.md) ·
[`09-Review-and-Approval-System`](./09-Review-and-Approval-System.md) ·
[`11-Roles-and-Permissions`](./11-Roles-and-Permissions.md) ·
[`12-Security-and-Compliance`](./12-Security-and-Compliance.md) ·
[`13-Performance-and-Scaling`](./13-Performance-and-Scaling.md) ·
[`14-Implementation-Roadmap`](./14-Implementation-Roadmap.md)
