---
title: "Platform Admin Audit — System Health & Ops Tab"
tab: system-health
status: read-only
last_audited: 2026-06-29
owner: platform-admin
---

## Executive Summary

The **System Health** tab (`/system-health`) is the staff console's single operational pane — a point-in-time read of TruePoint's runtime: five service status tiles (`api`, `database`, `workers`, `redis`, `search`) plus an enrichment job-queue panel (queue depth, dead-letter count, sampled per-status breakdown, truncation flag). It is backed by one endpoint, `GET /api/v1/admin/system-health`, and is genuinely honest about what it knows: `api`/`database` are inferred `up` from the fact that the audited transaction ran; `workers`/`redis` are **real** BullMQ probe results derived in `systemHealthProbes.ts` (`probeQueues` → `deriveServiceHealth`); and `search` is reported `unknown` rather than fabricating a green check it cannot verify. That intellectual honesty — never zeroing an unreachable queue, never inventing a status — is the tab's strongest quality and the bar any improvement must clear.

Status is **read-only** by design and the read path is correct on the fundamentals: it runs inside `withPlatformTx(actor, "admin.system_health", fn)` on the BYPASSRLS owner connection, the job sample is bounded by `PLATFORM_READ_LIMIT = 500` (`platformAdminReads.sampleJobStatuses`), and each of the three queue probes (`importQueueHealth`, `bulkQueueHealth`, `reverificationQueueHealth`) is timeout-bounded (~1.5s) and fanned out under `Promise.allSettled` so one dead queue never sinks the probe and the route can never hang or 500.

The gaps are not correctness gaps; they are **operability-maturity** gaps — the distance between a *status page* and an *ops console*. Three of five service probes (`api`/`database` self-asserted, `search` hardcoded `unknown`) are not live external health checks; there is **no DLQ remediation** (no retry/redrive/purge — the operator sees `deadLetter > 0` and is then powerless in-console); **no maintenance-mode toggle** (no way to declare a window or surface a customer banner); **no SLO / error-budget tracking** against ADR-0024's targets; **no FinOps cost attribution** for the metered enrichment spend this very queue drives; **no historical trend** (every reading is point-in-time — no sparklines, no retention); and **no alerting/paging** (nobody is woken when the DLQ climbs). The job figures are additionally a *bounded sample*, not an exact tally — adequate as a signal, wrong as a metric. None of the deferred items below are claimed to exist; they are specified as implementation-ready designs needing infra/security sign-off.

## Current Implementation Audit

**Frontend** (`apps/admin/src/features/system-health/*`, 7 files, ~115 LOC):

| File | Role |
|---|---|
| `components/SystemHealthPage.tsx` (~84 LOC) | The whole surface: header, Services `StatTile` grid (one tile per service, `StatusBadge` tone), Enrichment-job-queue grid (Queue depth / Dead-letter with attention/clear badge / Sampled jobs with truncation note), and a "By status" `Card`. `StateSwitch` four-state (loading/empty/error/data) |
| `api.ts` | The data seam — `fetchSystemHealth()` via `fetchWithAuth` against `/api/v1/admin/system-health`; RFC 9457 `detail`/`title` surfaced on failure |
| `hooks/useSystemHealth.ts` | Vanilla-React load hook holding `{health, loading, error, reload}` — **no TanStack Query**; `reload` is the only refresh (no polling) |
| `types.ts` | `ServiceStatus = "up"|"down"|"degraded"|"unknown"`, `ServiceHealth`, `JobsHealth`, `SystemHealth` — mirrors the API payload |
| `format.ts` (+`format.test.ts`) | `serviceTone` (status→badge tone) and `serviceLabel` (`api`→`API`, else capitalize); pure + unit-tested |
| `index.ts` | Public surface — re-exports `SystemHealthPage` for the App Router route `app/(shell)/system-health/page.tsx` |

**Backend** (`apps/api/src/features/admin/`):

- **Route**: `adminRoutes.get("/system-health", …)` (`routes.ts` ~L600-638). Runs `sampleJobStatuses` inside `withPlatformTx(actorOf(c), "admin.system_health", …)`, tallies `byStatus`, computes `queueDepth = queued + running + estimating` and `deadLetter = failed`, then calls `probeQueues().catch(...)` (belt-and-suspenders degrade to `redis:"down"/workers:"unknown"`). Returns `services[]`, `queues[]` (live per-queue), and `jobs{sampleSize, truncated, byStatus, queueDepth, deadLetter}`.
- **Probe aggregator**: `systemHealthProbes.ts` (~84 LOC). `probeQueues()` fans the three accessors via `allSettled`; a rejected probe becomes `reachable:false` with `null` counts. `deriveServiceHealth(queues)` is the **pure** threshold logic (Redis up iff ≥1 queue answered; workers `unknown` if none reachable, else `up` iff *any* reachable queue has ≥1 worker — any-queue, not a sum). Unit-tested in `systemHealthProbes.test.ts`.
- **Per-queue accessors**: `importQueueHealth` / `bulkQueueHealth` / `reverificationQueueHealth` reuse the lazy producer singletons, `Promise.race` a ~1.5s timeout, and read `getJobCounts(waiting,active,failed,delayed)` + `getWorkers()` off Redis.
- **Repository**: `platformAdminReads.sampleJobStatuses(tx)` selects `enrichment_jobs.status` `LIMIT PLATFORM_READ_LIMIT` and returns the status strings.

**Gate**: the route has **no explicit `requireStaffRole`/`requireCapability`** — only the coarse `authn → platformAdmin (pa===true)` chain. Per `list-plan/07`, the intended read tiers are `super_admin`, `support`, `read_only`. **Audit**: `admin.system_health` recorded as a read action string (not a `platformAuditAction` mutation), matching the sibling cross-tenant reads.

## Enterprise Benchmark Research

- **Datadog — DLQ inspect/redrive/purge + SLO error budgets.** Data Streams Monitoring surfaces non-empty dead-letter queues and exposes three in-product remediation actions — **Peek** (inspect failed message content), **Redrive** (requeue for another attempt), and **Purge** (clear) — directly from the queue side panel. Datadog also computes error budgets from an SLO target and window (a 99% / 7-day SLO yields ~3.5h of budget) with burn-rate alerts that fire when a % of budget is consumed. TruePoint shows `deadLetter > 0` and stops there; it has no redrive and no SLO/budget concept. ([Datadog DLQ](https://docs.datadoghq.com/data_streams/dead_letter_queues/), [Datadog Error Budget Alerts](https://docs.datadoghq.com/service_management/service_level_objectives/error_budget/))
- **Atlassian Statuspage — maintenance mode + subscriber notifications.** Statuspage auto-sets affected components to **Under Maintenance** when a scheduled window opens and back to **Operational** when it closes, and notifies email/SMS/webhook subscribers — including configurable reminders 1h or 24h before the window. TruePoint has no maintenance-mode toggle, no scheduled-window concept, and no customer-facing banner. ([Statuspage — Schedule maintenance](https://support.atlassian.com/statuspage/docs/schedule-maintenance/))
- **PagerDuty / BetterStack — paging on operational signal (well-known behaviour).** Both route monitor/threshold breaches (queue depth, DLQ growth, failed health checks) to on-call escalation policies with acknowledge/resolve and incident timelines. TruePoint has no alerting integration — a DLQ spike at 3am is visible only if a human happens to load the tab. *(Stated from well-known product behaviour; not from a fetched source this session.)*
- **AWS Health Dashboard / Salesforce Trust — historical status with per-component history.** Both publish time-series component history (not just a current dot), so an operator can see *when* a service degraded and for how long. TruePoint renders only the current instant — no trend, no history, no retention. *(Stated from well-known product behaviour.)*

## Gap Analysis

| # | Gap | Severity | Evidence |
|---|---|---|---|
| G1 | No explicit `requireStaffRole`/`requireCapability` gate on `/system-health` (coarse `pa` only) | High | `routes.ts` L600 — no role middleware vs sibling `/import-jobs` L649 which gates |
| G2 | `api`/`database`/`search` are not live health probes (self-asserted / hardcoded `unknown`) | High | `routes.ts` L621-627; `search` literal `"unknown"` |
| G3 | No DLQ remediation (retry/redrive/purge) — operator sees `deadLetter` but cannot act | High | No mutation route; `SystemHealthPage` is display-only |
| G4 | No maintenance-mode toggle + customer banner | High | No table, no flag, no endpoint |
| G5 | No SLO / error-budget tracking vs ADR-0024 targets | Medium | No SLO definition or burn computation anywhere |
| G6 | No FinOps cost attribution for metered enrichment (per tenant/provider) | Medium | Queue drives spend; no cost surface |
| G7 | No historical trend / sparklines (point-in-time only) | Medium | `reload` only; no time-series store |
| G8 | No alerting/paging integration (no proactive notification) | High | Visible only on manual load |
| G9 | Queue depth/DLQ from a **bounded sample**, not exact count | Medium | `LIMIT PLATFORM_READ_LIMIT`; `truncated` flag |
| G10 | No auto-refresh/polling — stale unless the operator hits retry | Low | `useSystemHealth` has no interval |
| G11 | No capability render-gate on the page (UI shows even for tiers that shouldn't act) | Low | No `useStaffMe().canMaybe(...)` |

## Functional Improvements

### F1 — DLQ remediation actions (redrive / purge)

- **Current state**: the tab shows `jobs.deadLetter` and a danger badge; there is no way to act on failed jobs from the console.
- **Problem**: an operator who sees a DLQ spike must SSH/script against Redis, off-console and unaudited — the audit log has no record of who flushed what.
- **Enterprise best practice**: Datadog DSM exposes Peek/Redrive/Purge directly from the queue panel.
- **Recommended implementation**: add `POST /api/v1/admin/system-health/queues/:queue/redrive` and `…/purge`. Each is an **audited mutation** following the recipe — Zod body in `@leadwolf/types`, new `platformAuditAction` values `queue.redrive` / `queue.purge` (+ `platformAuditCoverage.test.ts` PENDING→WRITTEN), a `platformAdminWriteRepository`/queue-admin method invoking BullMQ `retryJobs()`/`clean()`, wrapped in `withPlatformTx(actor, "queue.redrive", …, {targetType:"queue", targetId:queueName, metadata:{reason, count}})`, gated `requireCapability("system_health:remediate")`, **consuming a JIT elevation in-tx** (destructive). UI: confirm dialog with mandatory reason, render-gated via `canMaybe`.
- **Expected impact**: closes the loop from detection to remediation; every action audited and elevation-gated.
- **Dependencies**: G1 (gate), JIT elevation, `platformAuditAction` enum.
- **Priority**: High.

### F2 — Maintenance-mode toggle + customer banner

- **Current state**: no concept of a maintenance window anywhere in the platform.
- **Problem**: deploys/migrations happen with no operator switch and no customer-facing signal; support has no canonical "we're aware" state.
- **Enterprise best practice**: Statuspage auto-flips components to Under Maintenance and notifies subscribers with 1h/24h reminders.
- **Recommended implementation**: new platform table `maintenance_windows` (schema/platformOps.ts → `bun generate` → rls/platformOps.sql deny-all → REVOKE in applyMigrations.ts) with `{id, scope, status, starts_at, ends_at, message, created_by}`. `POST/PATCH /api/v1/admin/system-health/maintenance` audited (`maintenance.schedule`/`maintenance.end`), gated `requireCapability("system_health:maintenance")` + elevation. `GET` (public-safe) drives an `apps/web` banner.
- **Expected impact**: a controlled, audited maintenance state with customer-facing transparency.
- **Dependencies**: new platform table recipe, F7 flag, design (banner component).
- **Priority**: High.

### F3 — Auto-refresh + last-updated timestamp

- **Current state**: data loads once on mount; the operator must hit retry.
- **Problem**: an ops console silently going stale is dangerous — a recovered/degraded service looks frozen.
- **Enterprise best practice**: live status pages poll/stream and show "updated Ns ago".
- **Recommended implementation**: a ~15s interval in `useSystemHealth` (visibility-gated, paused when the tab is hidden) and a `fetchedAt` header line; behind flag `system_health.autorefresh`.
- **Expected impact**: trustworthy live signal without manual reload.
- **Dependencies**: none (frontend-only).
- **Priority**: Medium.

## Backend Improvements

### B1 — Real `api` / `database` / `search` probes

- **Current state**: `api`/`database` are asserted `up` from the running tx; `search` is hardcoded `"unknown"`.
- **Problem**: a degraded search cluster or a saturated DB connection pool is invisible — the tab reports green/unknown regardless.
- **Enterprise best practice**: per-component liveness checks (AWS/Salesforce per-service status).
- **Recommended implementation**: add to `systemHealthProbes.ts` a `dbProbe` (`SELECT 1` + `pg_stat_activity` pool saturation → `degraded` when near `max`) and a `searchProbe` (Meilisearch/OpenSearch `/health`, timeout-bounded, `allSettled`-fanned like the queues). Keep the never-fabricate rule: timeout → `unknown`, not green.
- **Expected impact**: three more services move from inferred/unknown to measured.
- **Dependencies**: search client health endpoint (infra) — **design-spec until the endpoint exists**.
- **Priority**: High.

### B2 — Exact queue/DLQ counts (replace the sample)

- **Current state**: `queueDepth`/`deadLetter` come from a `LIMIT 500` sample of `enrichment_jobs.status`; `truncated` warns when capped.
- **Problem**: at >500 in-flight jobs the figures are wrong as a metric (a backlog of 5,000 reads as 500).
- **Enterprise best practice**: exact queue gauges (the live BullMQ `getJobCounts` already in `probe.queues` is exact).
- **Recommended implementation**: surface `probe.queues[].{waiting,active,failed}` as the authoritative figures in the UI; keep the DB sample only as the by-status breakdown with its honest "sampled" label. Optionally add a `COUNT(*)` aggregate (no row scan) repository method for an exact backlog gauge.
- **Expected impact**: queue depth becomes a metric, not an estimate.
- **Dependencies**: none (data already in payload).
- **Priority**: Medium.

### B3 — SLO definitions + error-budget computation

- **Current state**: no SLO concept; ADR-0024 targets are documented but unmeasured here.
- **Problem**: there is no objective "are we within budget" signal — degradation is judged by eyeball.
- **Enterprise best practice**: Datadog computes remaining budget + burn rate from target/window with threshold alerts.
- **Recommended implementation**: define SLOs in config (per the ADR-0024 targets), persist good/bad event tallies, and compute remaining-budget + burn-rate server-side; expose via `GET /api/v1/admin/system-health/slos`. **Design-spec** — depends on a metrics/time-series store (B4).
- **Expected impact**: objective error-budget gating for ops decisions.
- **Dependencies**: B4 (time-series store), ADR-0024.
- **Priority**: Medium.

## Database Improvements

### D1 — Health-sample time-series table

- **Current state**: every reading is point-in-time; nothing is persisted.
- **Problem**: no trend, no MTTR analysis, no "when did this start" — every incident review starts blind.
- **Enterprise best practice**: per-component status history.
- **Recommended implementation**: new platform table `system_health_samples` (schema/platformOps.ts → `bun generate` → rls/platformOps.sql deny-all → REVOKE in applyMigrations.ts): `{id, captured_at, service, status, queue_name, depth, dead_letter}`, time-partitioned, written by a periodic worker (A1). Keyset-read for sparklines, bounded by `PLATFORM_READ_LIMIT`, with a retention cap.
- **Expected impact**: enables trend/sparklines (G7) and SLO history (B3).
- **Dependencies**: new platform table recipe, A1 (sampler worker).
- **Priority**: Medium.

### D2 — `maintenance_windows` table

- **Current state**: no maintenance-state persistence.
- **Problem**: maintenance is implicit; nothing records who declared it or when.
- **Enterprise best practice**: durable, audited maintenance records (Statuspage).
- **Recommended implementation**: as F2 — full platform-table recipe with RLS deny-all + REVOKE; reads bounded, writes via `withPlatformTx`.
- **Expected impact**: durable, audited maintenance lifecycle.
- **Dependencies**: F2.
- **Priority**: High.

## API Improvements

### A1 — Remediation + maintenance endpoints (audited mutations)

- **Current state**: `/system-health` is a single read; no write endpoints exist.
- **Problem**: every operational action (redrive, purge, maintenance) is off-console and unaudited.
- **Enterprise best practice**: in-product remediation with full action trail.
- **Recommended implementation**: add `POST …/queues/:queue/redrive`, `…/purge`, `POST/PATCH …/maintenance` per F1/F2 — each Zod-validated, `requireCapability`-gated, JIT-elevation-consuming, and audited via `withPlatformTx` with new `platformAuditAction` values and PENDING→WRITTEN attestation.
- **Expected impact**: a complete, auditable ops API surface.
- **Dependencies**: G1, JIT elevation, enum + coverage test.
- **Priority**: High.

### A2 — Explicit role gate on the read route (G1)

- **Current state**: only the coarse `pa` gate protects `/system-health`.
- **Problem**: the route is inconsistent with its siblings (`/import-jobs`, `/retention-runs` gate explicitly) and with `list-plan/07`'s intended tiers; any `pa` staffer reads it regardless of role.
- **Enterprise best practice**: least-privilege per route.
- **Recommended implementation**: add `requireStaffRole("super_admin","support","read_only")` to the `/system-health` GET, mirroring `/import-jobs`.
- **Expected impact**: read access matches the documented RBAC matrix.
- **Dependencies**: none (one-line middleware add).
- **Priority**: High.

## Dependency Mapping

- **DB tables**: `enrichment_jobs` (`sampleJobStatuses`); `import_jobs` (sibling monitor); *proposed*: `system_health_samples` (D1), `maintenance_windows` (D2); `platform_audit_log` (raw, bootstrapAdmin.ts — every mutation); `jit_elevations` (for proposed remediation).
- **Services / repositories**: `platformAdminReads.sampleJobStatuses`; *proposed* `platformAdminWriteRepository` queue-admin + maintenance methods; `withPlatformTx` (packages/db/src/client.ts).
- **API endpoints**: `GET /api/v1/admin/system-health` (live); *proposed* `POST …/queues/:queue/{redrive,purge}`, `POST/PATCH …/maintenance`, `GET …/slos`.
- **Event flow**: page mount → `useSystemHealth.reload` → `fetchSystemHealth` → `GET /system-health` → `withPlatformTx(admin.system_health)` { `sampleJobStatuses` + `probeQueues` } → JSON → `StateSwitch` render.
- **Background workers**: `apps/workers` import / bulk-import / reverification consumers (the queues being probed); *proposed* periodic health-sampler (A1/D1).
- **Queue dependencies**: BullMQ producers `IMPORTS_QUEUE`, `BULK_IMPORTS_QUEUE`, `REVERIFICATION_QUEUE` over Redis (`env.REDIS_URL`); probes reuse producer singletons.
- **Permission / capability**: coarse `platformAdmin` (`pa===true`); *proposed* `requireStaffRole(super_admin,support,read_only)` (read) and `requireCapability("system_health:remediate"|"system_health:maintenance")` (write) in `ROLE_CAPABILITIES` (`@leadwolf/types`).
- **Feature-flag dependencies**: *proposed* `system_health.autorefresh`, `system_health.maintenance`, `system_health.remediation`.
- **External integrations**: Redis (BullMQ); *proposed* search-cluster `/health` (B1), paging (PagerDuty/BetterStack, M2), customer status banner (`apps/web`).
- **Cross-module dependencies**: enrichment pipeline (job producer), import/bulk-import features (queue owners), audit-log tab (reads `platform_audit_log`), `@leadwolf/ui` State Kit (`StateSwitch`/`StatTile`/`StatusBadge`).

## Security Review

- **Tenant isolation**: the read runs on the BYPASSRLS owner connection via `withPlatformTx`; `enrichment_jobs` is sampled for *status strings only* — no contact PII, tenant id, or job payload crosses the boundary. Maintain this in any future surface (counts/metadata only).
- **Gate (G1 — finding)**: `/system-health` lacks an explicit `requireStaffRole`/`requireCapability`; only `pa` protects it. This is least-privilege drift vs siblings — close per A2 before adding any write.
- **Destructive writes**: redrive/purge (F1) and maintenance (F2) are privileged mutations — they **must** consume a JIT elevation in-tx and carry a mandatory reason, or `403 elevation_required`. Purge is irreversible: require elevation + typed confirmation, and consider super_admin-only.
- **Probe safety**: probes are read-only (`getJobCounts`/`getWorkers`), timeout-bounded, and `allSettled`-isolated — a hostile/slow Redis cannot hang or 500 the route.
- **Information exposure**: queue depth/DLQ are operational metadata (no customer data); the maintenance banner message is operator-authored — treat it as untrusted output and escape it in `apps/web`.
- **Deferred (need security sign-off)**: paging webhooks carry health metadata to a third party (PagerDuty) — scope the payload and store the integration secret in the **KMS provider store (deferred)**, never client-side.

## Performance Review

- **Read cost**: one `LIMIT 500` index-eligible scan of `enrichment_jobs.status` + three ~1.5s-bounded Redis probes fanned in parallel — cheap and predictably bounded; worst case is ~1.5s when all three queues are slow.
- **No N+1 / no unbounded scan**: the sample is hard-capped at `PLATFORM_READ_LIMIT`; probes reuse singletons (no per-request Redis connection).
- **Sample vs exact (G9/B2)**: the *sample* misrepresents large backlogs; the *live BullMQ counts* in `probe.queues` are exact and should be the displayed metric — a correctness win at zero added cost.
- **Auto-refresh (F3)**: a 15s poll multiplies this load by every open console tab; gate on document visibility and consider an ETag/304 to make refreshes near-free.
- **Time-series (D1)**: a periodic sampler must be a single scheduled worker, not per-request, to avoid write amplification.

## UX/UI Improvements

### U1 — Capability render-gates + "last updated"

- **Current state**: the page renders identically for every `pa` tier; no freshness indicator.
- **Problem**: read_only tiers see (future) action affordances they cannot use; operators can't tell how stale the view is.
- **Enterprise best practice**: capability-aware UI + visible recency.
- **Recommended implementation**: gate future action buttons with `useStaffMe().canMaybe("system_health:remediate")`; add a "updated Ns ago" line fed by F3.
- **Expected impact**: honest, role-appropriate, freshness-aware surface.
- **Dependencies**: F3, `staffMe`.
- **Priority**: Low.

### U2 — Surface live per-queue panel + trend sparklines

- **Current state**: the UI shows the DB sample tally; the richer live `queues[]` (per-queue waiting/active/failed/workers/reachable) is in the payload but unrendered.
- **Problem**: the most accurate, per-queue signal is discarded; there is no trend.
- **Enterprise best practice**: per-component live gauges + history (AWS/Salesforce).
- **Recommended implementation**: render a per-queue table (name, depth, DLQ, workers, reachable badge) from `health.queues`; add sparklines once D1 lands.
- **Expected impact**: a real ops view, not a single tally.
- **Dependencies**: B2 (display), D1 (sparklines).
- **Priority**: Medium.

## Automation Opportunities

- **Periodic health sampler** (A1/D1): a scheduled worker captures `system_health_samples` every N minutes — feeds trend, SLO history, and "when did it start."
- **DLQ growth alerting** (M2): a worker watches `deadLetter` / queue `failed` and pages on threshold breach (PagerDuty/BetterStack) — turns the tab from pull to push.
- **Auto-maintenance flips**: tie deploy/migration hooks to `maintenance_windows` so a release auto-declares and auto-clears the window (Statuspage-style automation).
- **SLO burn-rate alerts** (B3): fire when error-budget consumption crosses a threshold, not only on hard failure.

## Monitoring & Logging

- **Today**: every load writes a `admin.system_health` read row to `platform_audit_log` (who viewed health, when, from which IP) — good. The probe results themselves are **not** persisted (point-in-time only).
- **Add**: structured logs/metrics on probe outcomes (per-queue reachable/timeout, latency) so the *prober* is itself observable; emit a counter when `search`/`db` probes (B1) go `degraded`/`down`.
- **Add**: `system_health_samples` (D1) as the durable record behind trend + SLO; retain bounded and prune via the retention engine.
- **Add**: alert rules on DLQ depth and probe-failure streaks routed to on-call (M2).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Sample misreads a large backlog (G9) → operator under-reacts | Medium | High | B2 — display exact live BullMQ counts |
| Coarse gate (G1) lets any `pa` staffer read ops data | Medium | Medium | A2 — explicit `requireStaffRole` |
| Destructive remediation (purge) without elevation → data loss | Low | High | JIT elevation in-tx + typed confirm + super_admin-only |
| Auto-refresh amplifies load across many tabs | Medium | Low | visibility-gate + ETag/304 |
| Search/DB probes need infra not yet present → stays `unknown` | High | Medium | ship as design-spec; honest `unknown`, never fabricate |
| Maintenance banner message is operator-authored → XSS in `apps/web` | Low | Medium | escape on render; treat as untrusted |

## Technical Debt

- **G1 / A2**: missing explicit role gate on `/system-health` — one-line drift from the sibling pattern; fix first.
- **Dual job source**: the DB *sample* and the live *BullMQ* counts coexist in the payload; the UI shows the weaker one. Converge on the live counts (B2) and demote the sample to the by-status breakdown.
- **`search` hardcoded `unknown`**: honest, but a permanent placeholder until B1 lands — track it so it isn't forgotten as "done."
- **No polling**: `useSystemHealth` loads once; "system health" that doesn't update is a latent trust bug (F3).
- **No write path / audit vocabulary for ops actions**: redrive/purge/maintenance need new `platformAuditAction` enum values + PENDING→WRITTEN attestation before any mutation ships.

## Multi-Phase Implementation Plan

### Phase 1 — Correctness & quick wins (Critical/High)

- **Objectives**: make the tab correct, least-privilege, and live without new infra.
- **Scope**: A2 (explicit role gate), B2 (display exact live queue counts), U2-display (per-queue panel from `queues[]`), F3 (auto-refresh + last-updated), U1 (capability render-gates).
- **Deliverables**: gated `/system-health`; UI showing exact per-queue depth/DLQ/workers; visibility-gated 15s poll; "updated Ns ago."
- **Technical tasks**: add `requireStaffRole("super_admin","support","read_only")`; render `health.queues` table; add interval + `fetchedAt` to `useSystemHealth`; wire `canMaybe`.
- **Risks**: poll load (mitigate via visibility-gate/ETag).
- **Dependencies**: none beyond existing payload + `staffMe`.
- **Testing**: route-gate test (403 for non-listed role); `format`/render unit tests; poll pause-on-hidden test.
- **Estimated complexity**: Low.
- **Success criteria**: non-authorized role gets 403; UI shows exact live counts; view refreshes and shows recency.

### Phase 2 — Remediation, maintenance & history (High/Medium)

- **Objectives**: turn the status page into an ops console.
- **Scope**: F1 (DLQ redrive/purge), F2/D2 (maintenance mode + banner), A1 (audited mutation endpoints), D1 (health-sample time-series) + U2-sparklines, B1 (db/search probes — design-spec if infra absent).
- **Deliverables**: audited redrive/purge with elevation; maintenance lifecycle + `apps/web` banner; `system_health_samples` + sparklines; real db (and search, infra-permitting) probes.
- **Technical tasks**: per recipe — Zod + `platformAuditAction` (`queue.redrive`/`queue.purge`/`maintenance.schedule`/`maintenance.end`) + PENDING→WRITTEN + `platformAdminWriteRepository` methods + `withPlatformTx` routes + `requireCapability` + JIT-elevation consume + admin dialogs; two platform tables via the table recipe; periodic sampler worker; `dbProbe`/`searchProbe` in `systemHealthProbes.ts`.
- **Risks**: destructive purge (elevation + confirm); search probe blocked on infra (ship design-spec).
- **Dependencies**: Phase 1 gate; JIT elevation; new platform-table recipe; design (banner).
- **Testing**: audit-coverage drift test stays green; elevation-required (403) tests; RLS deny-all + REVOKE verification on new tables; sampler idempotency; probe timeout/`allSettled` tests.
- **Estimated complexity**: Medium-High.
- **Success criteria**: redrive/purge audited + elevation-gated; maintenance state durable and customer-visible; trend renders from persisted samples.

### Phase 3 — SLOs, FinOps & alerting (flag-heavy; Medium/Low)

- **Objectives**: objective service levels, cost visibility, and proactive paging.
- **Scope**: B3 (SLO + error budgets), G6 (FinOps cost attribution per tenant/provider), M2 (DLQ/burn-rate alerting → PagerDuty/BetterStack), SLO/cost dashboards. All behind flags.
- **Deliverables**: `GET …/slos`; cost panel by tenant/provider; on-call paging on threshold breach.
- **Technical tasks**: SLO config + good/bad tallies + burn computation; cost attribution from metered enrichment spend (FinOps); paging webhook integration with KMS-stored secret (**deferred — needs security sign-off**); flags `system_health.{slos,finops,alerting}`.
- **Risks**: paging integration ships customer/health metadata externally — scope payload, secure secret in KMS (deferred).
- **Dependencies**: D1 (time-series), metered-enrichment ledger (cross-program), KMS provider store (deferred), security sign-off for paging.
- **Testing**: budget-math unit tests; alert-threshold tests; cost-aggregation correctness; secret-handling review.
- **Estimated complexity**: High.
- **Success criteria**: error budgets computed and alertable; per-tenant/provider cost visible; on-call paged on real breaches.

## Final Recommendations

### R1 — Gate the read route (do this first)

- **Current state**: `/system-health` is protected only by the coarse `pa` gate.
- **Problem**: least-privilege drift from every sibling read route and from `list-plan/07`.
- **Enterprise best practice**: per-route least privilege.
- **Recommended implementation**: add `requireStaffRole("super_admin","support","read_only")` to the GET.
- **Expected impact**: read access matches the RBAC matrix; one-line, zero-risk.
- **Dependencies**: none.
- **Priority**: Critical.

### R2 — Show the exact live counts, demote the sample

- **Current state**: UI displays the `LIMIT 500` sample; exact `probe.queues` counts are discarded.
- **Problem**: large backlogs are silently understated — a trust bug for an ops console.
- **Enterprise best practice**: exact per-component gauges.
- **Recommended implementation**: render `health.queues[].{waiting,active,failed,workers}`; keep the sample only for the labelled by-status breakdown.
- **Expected impact**: queue depth becomes a metric, not an estimate; zero added cost.
- **Dependencies**: none (data present).
- **Priority**: High.

### R3 — Add audited, elevation-gated remediation + maintenance

- **Current state**: no write path; ops actions happen off-console and unaudited.
- **Problem**: detection without remediation, and no audited maintenance state.
- **Enterprise best practice**: in-product redrive/purge (Datadog) and maintenance mode (Statuspage).
- **Recommended implementation**: F1/F2/A1/D2 via the audited-mutation + platform-table recipes, JIT-elevation-gated.
- **Expected impact**: a closed, fully-audited operate loop.
- **Dependencies**: R1, JIT elevation, `platformAuditAction` enum + coverage test.
- **Priority**: High.

### R4 — Persist samples; then layer SLOs, FinOps & paging

- **Current state**: point-in-time only; no trend, SLO, cost, or alert.
- **Problem**: every incident review starts blind and reactive.
- **Enterprise best practice**: status history + error budgets + paging (AWS/Datadog/PagerDuty).
- **Recommended implementation**: D1 time-series → B3 SLOs → G6 FinOps → M2 alerting, flag-gated, with the paging secret in the deferred KMS store.
- **Expected impact**: proactive, objective, cost-aware operations.
- **Dependencies**: D1, metered-enrichment ledger, KMS (deferred), security sign-off.
- **Priority**: Medium.
