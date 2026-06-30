---
title: Platform Admin — Bulk Imports Tab Audit
tab: imports
status: read-only
last_audited: 2026-06-29
owner: platform-admin
---

# Platform Admin — Bulk Imports Tab Audit

## 1. Executive Summary

The **Bulk Imports** tab is the platform-admin monitoring surface for TruePoint's cross-tenant bulk-import pipeline (the COPY-staging, AV-gated, chunked-upsert pipeline specified in `docs/planning/30-bulk-import-export-pipeline.md` / ADR-0036). It is **read-only-wired (monitor)**: a staff operator with `super_admin`, `support`, or `read_only` role sees the most-recent import jobs across every tenant — tenant name + id, source filename, status (+ failure reason), AV-scan verdict, and the create/match/reject row tallies — newest-first and bounded by `PLATFORM_READ_LIMIT` (500). There are **no mutations on this surface**: no retry, no quarantine/AV re-scan trigger, no drill-down into the per-row error ledger, no filters, no export-jobs counterpart.

Surface map (verified):

- **Frontend:** `apps/admin/src/features/imports/*` (6 files, ~147 LOC) — `api.ts`, `types.ts`, `format.ts`, `index.ts`, `components/ImportsMonitorPage.tsx`, `hooks/useImportJobs.ts`. Route `/imports`. Vanilla React (`useState`/`useEffect`, NO TanStack), `fetchWithAuth` (ADR-0016), four-state rendering via `StateSwitch`.
- **API:** `GET /api/v1/admin/import-jobs` (`apps/api/src/features/admin/routes.ts:649`), gated `requireStaffRole("super_admin","support","read_only")`, recorded as the read action `admin.list_import_jobs` inside `withPlatformTx`.
- **Data:** repo `platformAdminRepository.recentImportJobs` (`packages/db/src/repositories/platformAdminReads.ts:400`) — selects `import_jobs` joined to `tenants`, **never `import_job_rows`** (no contact PII crosses the boundary). Schema `packages/db/src/schema/importJobs.ts` (`import_jobs`, `import_job_chunks`, `import_job_rows`).
- **Workers:** the `imports` BullMQ queue processor (`apps/workers/src/queues/imports.ts`) runs the shared `runImport` core pipeline (COPY → UNLOGGED staging → dedup → chunked upsert), reports coarse progress, and dead-letters PII-free on retry exhaustion. The dedicated `bulk-imports` queue (`BULK_IMPORTS_QUEUE`, `packages/types/src/bulkImport.ts:12`) is the millions-of-rows variant.
- **Audit:** the read is `admin.list_import_jobs` — a plain `withPlatformTx` string, deliberately NOT in the `platformAuditAction` mutation enum (only writes are enum-tracked, per ADR-0032).

The dominant gaps are **operability and reach**, not correctness. The monitor is honest about what it shows (metadata + tallies, no PII), but a staff operator who sees a `failed` or `infected` job has **no remediation path inside the console** — they must pivot to Sentry/logs/Redis to find the per-row reasons and have no in-product way to retry, re-scan, requeue from the DLQ, or even filter to one tenant. There is also **no `import_jobs` capability** in the matrix at all; the read is role-gated only. This audit treats the monitor as a correct foundation and specifies the operability layer on top of it.

## 2. Current Implementation Audit

**Frontend (`apps/admin/src/features/imports/`).**

| File | Role |
|---|---|
| `components/ImportsMonitorPage.tsx` | The whole surface: a `DataTable` of import jobs through `StateSwitch` (loading/empty/error/data). Columns: Tenant (name + mono id), Source (filename), Status (`StatusBadge` + inline `failedReason`), Created / Matched / Rejected (right-aligned, thousands-formatted), AV scan (`StatusBadge`), Created date. **No row actions, no filters, no pagination control.** |
| `hooks/useImportJobs.ts` | `useState`/`useEffect` loader with `{jobs, error, loading, reload}` (house convention; NO TanStack). |
| `api.ts` | `fetchImportJobs()` → `GET /api/v1/admin/import-jobs` via `fetchWithAuth`; RFC-9457 `problemMessage` extraction. The slice's only seam — the console never touches the DB. |
| `types.ts` | `ImportJobRow` view-model (jobId, tenantId, tenantName, status, sourceName, avScanStatus, rowsTotal/Created/Matched/Rejected, createdAt, completedAt, failedReason). Presentation types only; the api owns the canonical shape. |
| `format.ts` | Pure DOM-free helpers: `jobStatusTone` / `avScanTone` (closed-enum → `StatusBadge` tone), `shortDate`, `formatInt`. Unit-testable. |
| `index.ts` | Public surface — exports `ImportsMonitorPage` only. |

The page is **not render-gated to a capability** (`useStaffMe().canMaybe(...)` is not used here): it relies entirely on the shell's `adminGate` + the server's `requireStaffRole`. That matches the sibling read-only directories (Tenants / Users / Retention-runs), and since there are no actions to hide, the absence of a render-gate is currently defensible — but it becomes a gap the moment the first action lands (§10, §12).

**API (`apps/api/src/features/admin/routes.ts:649`).**

```
adminRoutes.get(
  "/import-jobs",
  requireStaffRole("super_admin", "support", "read_only"),
  async (c) => {
    const jobs = await withPlatformTx(actorOf(c), "admin.list_import_jobs", (tx) =>
      platformAdminRepository.recentImportJobs(tx),
    );
    return c.json({ jobs });
  },
);
```

The chain is `authn` → `platformAdmin` (`pa===true`) → `requireStaffRole(...)` (both `adminRoutes.use("*", ...)` at the top of the file). The read runs inside `withPlatformTx` so it is audited as `admin.list_import_jobs`. The response shape is returned directly via `c.json` (no Zod response schema), matching the sibling cross-tenant list reads — the repo's typed row IS the contract.

**Data (`platformAdminReads.ts:400` / `schema/importJobs.ts`).**

`recentImportJobs(tx, limit = PLATFORM_READ_LIMIT)` selects exactly the monitor's columns from `import_jobs` `innerJoin tenants`, `orderBy(desc(createdAt))`, `limit(Math.min(limit, PLATFORM_READ_LIMIT))` — a caller can never widen the cap. The `import_jobs` control table carries rich state the monitor does **not** yet surface: `conflictPolicy` (`overwrite|skip|keep_both`), `columnMapping` (jsonb), `targetListId`, `fileSize`, `idempotencyKey`, `byteOffset` (resume watermark), `totalChunks`/`completedChunks`, and the full nine-bucket tally (`rowsTotal/Created/Matched/Duplicate/Skipped/Rejected/Deduped/Unprocessed`), `rejectedArtifactKey` (S3 key of the rejects file), `startedAt`/`completedAt`/`failedReason`. The per-row ledger `import_job_rows` (outcome enum `created|matched|duplicate|skipped|rejected|unprocessed`, `rejectReason`, audit-pointer ids) is the drill-down source — **but it is never read by this surface, by design** (it holds the raw parsed CSV row in `input` jsonb = PII).

**Workers (`apps/workers/src/queues/imports.ts`).** `processImport` reports `ImportProgress`, calls shared `runImport`, treats a wholly-failed import (`landed === 0`) as a job-level `ImportFailedError` so BullMQ retries and ultimately dead-letters via `deadLetterFailedImport` — which writes a **PII-free** `ImportDeadLetter` (scope + provenance + reason only, never raw rows). This DLQ is **invisible to the console** today.

## 3. Enterprise Benchmark Research

Four grounded comparisons against named products. Where a claim is from documented product behaviour rather than a fetched spec it is marked.

- **Salesforce Bulk API 2.0 — three-way result retrieval.** A completed ingest job exposes three separate result sets via dedicated endpoints: `GET /jobs/ingest/{jobID}/successfulResults/`, `/failedResults/`, and **`/unprocessedRecords/`** — failed and unprocessed are distinct, downloadable CSVs, and each failed row carries a `sf__Error` column with the exact reason ([Get Job Failed Record Results](https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/get_job_failed_results.htm), [Get Job Unprocessed Record Results](https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/get_job_unprocessed_results.htm)). TruePoint's `import_jobs` already models this three-way split (`rowsRejected` vs `rowsUnprocessed`, plus `rejectedArtifactKey`) — but the admin monitor surfaces neither the unprocessed lane nor any downloadable error artifact.
- **Fivetran — "Failed Records" alert distinct from "Failed Sync", plus one-click re-sync.** Fivetran's Status page distinguishes a **Failed Sync** ("the sync completely failed… the connection is broken") from a **Failed Records** alert ("the sync ran successfully but some records were invalid in the source or rejected by the destination"), and an operator can **initiate a re-sync from the dashboard** after fixing the error ([Fivetran Sync Alerts](https://fivetran.com/docs/activations/syncs/sync-monitoring/alerts), [Status](https://fivetran.com/docs/using-fivetran/fivetran-dashboard/connectors/status)). TruePoint's monitor collapses "the job failed" and "the job landed with rejects" into adjacent badges with no alert and no re-run affordance.
- **Census / Hightouch — per-sync run history with rejected-row drill-down.** Reverse-ETL monitors (Hightouch sync "runs", Census "sync history") give a per-run breakdown of added/updated/rejected with the **specific error per rejected record** and a retry of failed records, surfaced in-product (documented product behaviour). TruePoint staff must leave the console for Sentry to get per-row reasons.
- **Airbyte / Fivetran job monitor — throughput and latency telemetry.** Both expose per-sync **rows/sec, bytes moved, and duration**, with the Fivetran Platform Connector landing sync logs + metadata into the customer's warehouse for SLA dashboards ([Fivetran Platform Connector](https://fivetran.com/docs/logs/fivetran-platform)). TruePoint's monitor shows zero throughput/latency/SLA telemetry — no rows/sec, no queue depth attribution, no time-to-complete.

## 4. Gap Analysis

| # | Gap | Severity | Evidence |
|---|---|---|---|
| G1 | No drill-down to per-row reject reasons; staff pivot to Sentry/logs | High | monitor reads `import_jobs` only; `import_job_rows.rejectReason` never surfaced |
| G2 | No retry / requeue / DLQ visibility — a dead-lettered import is invisible | High | `deadLetterFailedImport` writes DLQ; console has no DLQ read |
| G3 | No AV re-scan / quarantine action on an `infected`/`pending` job | High | `avScanStatus` shown but inert |
| G4 | No per-tenant filter, search, or status filter | Medium | `ImportsMonitorPage` renders the full bounded list, no controls |
| G5 | No throughput / latency / SLA metrics (rows-sec, duration) | Medium | no derived columns; `startedAt`/`completedAt` not even shown |
| G6 | No export-jobs counterpart (ADR-0036 is import **and** export) | Medium | no `/admin/export-jobs` endpoint exists |
| G7 | No `import_jobs` capability in the matrix; read is role-only | Low | `staffCapability` has no `imports:*` entry |
| G8 | Rich `import_jobs` state hidden (conflict policy, chunks, unprocessed, deduped, file size) | Low | repo selects 13 of ~25 columns |
| G9 | No cost-of-import (enrichment charged on imported rows) attribution | Low | no `ai_requests`/cost ledger join (ledger deferred) |
| G10 | No schedule/recurring-import visibility | Low | no recurring-import concept in schema yet |

## 5. Functional Improvements

### 5.1 Import-job drill-down (per-row reject reasons)

- **Current state:** the monitor shows aggregate tallies only; a `failed`/`partial` job gives no in-console way to see *which* rows failed and *why*.
- **Problem:** staff debug imports by leaving the product for Sentry/SQL, which is slow, error-prone, and untracked. The data already exists (`import_job_rows.rejectReason`, `outcome`).
- **Enterprise best practice:** Salesforce Bulk API 2.0 returns a `failedResults` CSV with a per-row `sf__Error`; Hightouch/Census show per-record reject reasons in the run drawer.
- **Recommended implementation:** add `GET /api/v1/admin/import-jobs/:jobId/rejects` → new repo `platformAdminRepository.importJobRejectSample(tx, jobId, limit≤100)` selecting `rowIndex, outcome, rejectReason` from `import_job_rows` WHERE `outcome IN ('rejected','unprocessed')` — **reason + index only, NOT the `input` jsonb** (PII stays inside the boundary). Render in a `Drawer` opened from a "View errors" row action. Recorded as a new read action `admin.list_import_job_rejects`.
- **Expected impact:** import debugging moves from a multi-tool 15-minute pivot to a one-click drawer; PII never leaves the DB.
- **Dependencies:** `import_job_rows` schema (exists); `Drawer` from `@leadwolf/ui`; PII review by truepoint-security (confirm reason strings are scrubbed of raw values).
- **Priority:** High

### 5.2 Retry / requeue a failed import (audited mutation)

- **Current state:** no action; a transient-failure import that exhausted BullMQ retries is dead and invisible.
- **Problem:** the only recovery is asking the tenant to re-upload, losing the original provenance and idempotency key.
- **Enterprise best practice:** Fivetran one-click re-sync; Salesforce Data Loader re-submit of the failed-records file.
- **Recommended implementation:** `POST /api/v1/admin/import-jobs/:jobId/retry`. Full audited-mutation recipe: Zod body (`{reason}`) in `@leadwolf/types`; add `import_job.retry` to the `platformAuditAction` enum (`packages/types/src/platformAudit.ts`) + flip `platformAuditCoverage.test.ts` PENDING→WRITTEN; `platformAdminWriteRepository.requeueImportJob(tx, jobId)` (re-enqueue onto `IMPORTS_QUEUE`/`BULK_IMPORTS_QUEUE` from the original `sourceFile` S3 key, reusing `idempotencyKey`); route wraps it in `withPlatformTx(actor, "import_job.retry", fn, {targetType:"import_job", targetId:jobId, tenantId, metadata:{reason}})`; gate `requireCapability("imports:operate")` (new cap, §10); admin UI confirm dialog. Sensitive enough to **consume a JIT elevation** in-tx (mirrors `credit.adjust`/`tenant.suspend`).
- **Expected impact:** closes G2; recovers transient failures without tenant involvement, fully audited.
- **Dependencies:** new `imports:operate` capability; queue producer access from apps/api; JIT elevation; truepoint-security sign-off on re-enqueue from a quarantine-promoted object.
- **Priority:** High

### 5.3 AV re-scan / quarantine action

- **Current state:** `avScanStatus` (`pending|clean|infected|skipped`) is shown as an inert badge.
- **Problem:** an `infected` or stuck-`pending` upload has no operator action — and an infected object should be tombstoned, not just labelled.
- **Enterprise best practice:** OneTrust/Transcend and AV-gated upload pipelines expose a re-scan + quarantine-tombstone control with full audit.
- **Recommended implementation:** `POST /api/v1/admin/import-jobs/:jobId/rescan` and `/tombstone`; audit actions `import_job.rescan` / `import_job.tombstone`; re-trigger the GuardDuty/ClamAV scan (doc 30 §1) or hard-delete the quarantine object + mark the job `failed`. Both audited via `withPlatformTx`, `requireCapability("imports:operate")`, elevation-gated for `tombstone`.
- **Expected impact:** closes G3; gives an actionable malware-response path that today lives only in S3/infra.
- **Dependencies:** AV scanner integration (doc 30 §1 / doc 01 / doc 08); object-store delete credentials; security sign-off (this is a destructive, compliance-relevant action).
- **Priority:** High

### 5.4 Filters, search, and status facets

- **Current state:** the full bounded list, unfiltered.
- **Problem:** at 500 cross-tenant rows an operator cannot isolate one tenant's failures or all `infected` jobs.
- **Enterprise best practice:** every CRM/ETL job monitor (Fivetran Status, Salesforce Bulk Jobs) filters by status/connection/date.
- **Recommended implementation:** extend `recentImportJobs` to accept `{tenantId?, status?, avScanStatus?, since?}` and a keyset cursor (base64url, limit+1 probe — the established platform-read pattern); add filter controls + tenant entity-picker to the page; keep the `PLATFORM_READ_LIMIT` clamp.
- **Expected impact:** closes G4; turns a flat list into a triage tool.
- **Dependencies:** tenant entity-picker (Phase 1 program component); keyset-cursor helper (exists for other platform reads).
- **Priority:** Medium

## 6. Backend Improvements

### 6.1 Surface the full nine-bucket reconciliation

- **Current state:** the repo returns only `rowsTotal/Created/Matched/Rejected`.
- **Problem:** ADR-0036's reconciliation identity is `rows_in = succeeded + rejected + deduped + unprocessed`; the monitor can't show whether a job *balances*, so it can't show `partial`/`unprocessed` honestly.
- **Enterprise best practice:** Salesforce surfaces unprocessed as a first-class result set distinct from failed.
- **Recommended implementation:** extend `recentImportJobs` select + `ImportJobRow` to include `rowsDuplicate, rowsSkipped, rowsDeduped, rowsUnprocessed, startedAt, completedAt, conflictPolicy, fileSize`; render a reconciliation cell that flags a non-balancing job.
- **Expected impact:** closes G8; the monitor matches the pipeline's own accounting contract.
- **Dependencies:** none (all columns exist on `import_jobs`).
- **Priority:** Medium

### 6.2 Dead-letter-queue read (failed-import visibility)

- **Current state:** `deadLetterFailedImport` writes a PII-free DLQ record; nothing reads it back into the console.
- **Problem:** a fully-failed import that exhausted retries simply disappears — the operator never learns it died.
- **Enterprise best practice:** Datadog/CloudWatch DLQ dashboards; AWS SQS DLQ redrive.
- **Recommended implementation:** `GET /api/v1/admin/import-jobs/dlq` reading the BullMQ `IMPORTS_DLQ`/`BULK_IMPORTS_DLQ` (via the api's Redis producer singletons, the same pattern `/system-health` uses for live queue depth); recorded as `admin.list_import_dlq`. Pairs with the 5.2 retry to enable redrive.
- **Expected impact:** closes G2's visibility half.
- **Dependencies:** Redis/BullMQ producer access from apps/api (already used by `/system-health`).
- **Priority:** High

## 7. Database Improvements

### 7.1 Composite index for the monitor's filtered read

- **Current state:** `import_jobs` has `idx_import_jobs_ws_status` (workspace-scoped) and `uniq_import_jobs_ws_idempotency`; the cross-tenant monitor orders by `created_at DESC` with no supporting index.
- **Problem:** at scale a global `ORDER BY created_at DESC LIMIT 500` does a full scan + sort; adding tenant/status filters (5.4) makes it worse.
- **Enterprise best practice:** index the monitor's actual access path (the platform-read keyset).
- **Recommended implementation:** add `idx_import_jobs_created_at` on `(created_at DESC)` and, for the filtered path, `idx_import_jobs_tenant_created` on `(tenant_id, created_at DESC)` (new-platform-table-style change: edit `schema/importJobs.ts` → `bun generate` → migration). No RLS change (table already has its policy).
- **Expected impact:** keeps the cross-tenant read keyset-fast as `import_jobs` grows.
- **Dependencies:** Drizzle generate + `applyMigrations.ts`.
- **Priority:** Medium

### 7.2 Honor the `import_job_rows` partitioning intent

- **Current state:** `import_job_rows` is a plain table; the schema comment notes doc 03 §12 targets monthly range-partitioning (like `activities`/`provider_calls`/`enrichment_job_rows`).
- **Problem:** the reject-drill-down (5.1) reads this high-volume table; unpartitioned it degrades as imports accumulate.
- **Enterprise best practice:** time-range-partition append-only high-volume ledgers.
- **Recommended implementation:** when volume warrants, convert `import_job_rows` to monthly `RANGE (created_at)` partitions with the existing `idx_import_job_rows_job` carried per-partition; document, don't silently drop, the intent.
- **Expected impact:** keeps drill-down and retention sweeps bounded.
- **Dependencies:** truepoint-platform (partitioning strategy), retention engine already lists `import_job_rows` in `RETENTION_V1_CLASSES`.
- **Priority:** Low

## 8. API Improvements

### 8.1 Export-jobs monitor (ADR-0036 symmetry)

- **Current state:** no `/admin/export-jobs` endpoint; ADR-0036 covers import **and** export.
- **Problem:** bulk exports (raw PII leaving the platform under signed links) are *more* compliance-sensitive than imports and have **zero** staff oversight.
- **Enterprise best practice:** OneTrust DSAR/export audit; Census/Hightouch surface every outbound sync.
- **Recommended implementation:** add an `export_jobs` table (`schema/...` → `bun generate` → `rls/...sql` deny-all-to-leadwolf_app + REVOKE in `applyMigrations.ts`) mirroring `import_jobs`; `GET /api/v1/admin/export-jobs` + `platformAdminRepository.recentExportJobs`; a sibling `apps/admin/src/features/exports/*` slice; read action `admin.list_export_jobs`. Counts + signed-link-status only, never the exported payload.
- **Expected impact:** closes G6; gives the export side the same monitor the import side has.
- **Dependencies:** export pipeline must exist (doc 30 §6–8); truepoint-security on signed-link governance.
- **Priority:** Medium

### 8.2 Response Zod schema for the read

- **Current state:** `/import-jobs` returns the repo row directly via `c.json` (no response schema).
- **Problem:** acceptable for a metadata read, but as the shape grows (6.1) an explicit boundary schema prevents accidental column leakage (e.g. never serialize `columnMapping`/`sourceFile`).
- **Enterprise best practice:** validate at the trust boundary on the way out.
- **Recommended implementation:** define `importJobRowSchema` in `@leadwolf/types`, parse before `c.json`; assert the select never includes PII-adjacent columns.
- **Expected impact:** a regression-proof boundary as the surface gains columns.
- **Dependencies:** `@leadwolf/types`.
- **Priority:** Low

## 9. Dependency Mapping

- **DB tables:** `import_jobs` (read; control row), `tenants` (join for name); `import_job_chunks` + `import_job_rows` (drill-down, not yet read); proposed `export_jobs`. Audit sink `platform_audit_log` (raw, `bootstrapAdmin.ts`).
- **Services / repositories:** `platformAdminRepository.recentImportJobs` (`platformAdminReads.ts:400`); proposed `importJobRejectSample`, `recentExportJobs`, and write methods `requeueImportJob` / `rescanImportJob` / `tombstoneImportJob` on `platformAdminWriteRepository`. `withPlatformTx` (`packages/db/src/client.ts`).
- **API endpoints:** `GET /api/v1/admin/import-jobs` (live). Proposed: `GET …/import-jobs/:jobId/rejects`, `GET …/import-jobs/dlq`, `POST …/import-jobs/:jobId/{retry,rescan,tombstone}`, `GET …/export-jobs`.
- **Event flow:** presigned-S3 upload → quarantine `ObjectCreated` → AV scan → promote → `imports`/`bulk-imports` queue → `runImport` (COPY → staging → dedup → upsert) → `import_jobs` status/tally updates → (this monitor reads the control row). Failure → retry → DLQ.
- **Background workers:** `apps/workers/src/queues/imports.ts` (`processImport`, `deadLetterFailedImport`); the dedicated `bulk-imports` worker.
- **Queue dependencies:** `IMPORTS_QUEUE`/`IMPORTS_DLQ` (`packages/types/src/contacts.ts:236/250`), `BULK_IMPORTS_QUEUE`/`BULK_IMPORTS_DLQ` (`packages/types/src/bulkImport.ts:12/14`), Redis/BullMQ. A DLQ read + retry needs the api's Redis producer singletons (the `/system-health` pattern).
- **Permission / capability dependencies:** read gated `requireStaffRole("super_admin","support","read_only")`; **no capability exists today**. Proposed `imports:operate` (mutations) + `imports:read` (read) added to `staffCapability` (`packages/types/src/staffCapability.ts`) + `ROLE_CAPABILITIES`.
- **Feature-flag dependencies:** none today. Mutations (5.2–5.3) should ship behind a kill-switch flag (`platform.imports.actions`).
- **External integrations:** S3 (object store, presign + quarantine/working buckets), GuardDuty Malware Protection / ClamAV (AV scan), Redis (BullMQ). Postgres `COPY` + UNLOGGED staging.
- **Cross-module dependencies:** retention engine (`import_job_rows` ∈ `RETENTION_V1_CLASSES`); enrichment (imports can trigger enrichment charges → cost attribution, deferred ledger); `@leadwolf/core` `runImport` (shared by api + workers — one implementation, two transports).

## 10. Security Review

- **Tenant isolation / PII (strong today).** The cross-tenant read is owner-connection + `withPlatformTx`-audited, bounded to `PLATFORM_READ_LIMIT`, and **deliberately reads only `import_jobs`, never `import_job_rows`** — no imported contact PII crosses the boundary. The DLQ record is PII-free by construction. Any drill-down (5.1) MUST preserve this: return `rejectReason` + `rowIndex` only, never the `input` jsonb. **truepoint-security is the boundary here — the drill-down PII review is mandatory, not optional.**
- **Capability gap (G7).** The read is role-gated only; there is no `imports:*` capability. **Recommended:** add `imports:read` (granted to `support`, `read_only`, `compliance_officer`) and `imports:operate` (granted to `support`; `super_admin` implies all) to `staffCapability` + `ROLE_CAPABILITIES`, then move the read to `requireCapability("imports:read")` and gate every proposed mutation behind `requireCapability("imports:operate")`. **Priority: High** (it's a prerequisite for any action landing). Re-checked per request (no JWT staleness on revoke).
- **Destructive-action gating.** Retry, rescan, and especially `tombstone` (destroys a quarantine object) are sensitive: each MUST consume a JIT elevation in-tx (`FOR UPDATE SKIP LOCKED`, ~10-min TTL) or 403 `elevation_required`, mirroring `credit.adjust`/`tenant.suspend`. **Priority: High.**
- **Idempotency-Key on mutations (DEFERRED pattern).** The credit endpoint lacks Idempotency-Key; the same gap will apply to `retry` (a double-click could double-enqueue). **Design spec:** accept an `Idempotency-Key` header on all imports mutations, dedup in-tx against a key table. Needs the platform-wide idempotency decision. **Priority: Medium — needs platform sign-off.**
- **Render-gate (defence-in-depth).** Once actions exist, gate their affordances with `useStaffMe().canMaybe("imports:operate")` — UI-only; the server stays authoritative. **Priority: High (with the action phase).**

## 11. Performance Review

- **Read path.** A single bounded query (≤500 rows) + one `tenants` join; cheap today. The missing `(created_at DESC)` index (7.1) is the only scaling risk — a global sort over a growing `import_jobs` will regress; add the index before the table is large.
- **No N+1.** The join is in-query; the page renders one `DataTable`. No per-row fetches.
- **Drill-down cost.** `importJobRejectSample` must be `LIMIT`-capped (≤100) and indexed by `idx_import_job_rows_job` (exists) — never an unbounded scan of the high-volume rows table; partitioning (7.2) protects it long-term.
- **DLQ/queue reads.** Reading BullMQ depth is O(1)-ish via the producer; reuse the timeout-bounded probe discipline of `/system-health` so a slow Redis never hangs the route.
- **No client-side perf issue.** Vanilla React, single fetch, no polling today (a future auto-refresh should be opt-in + interval-bounded).

## 12. UX/UI Improvements

### 12.1 Surface timing + reconciliation, add a row action menu

- **Current state:** columns are tenant/source/status/created/matched/rejected/AV/date; no duration, no unprocessed/deduped, no actions, two columns both labelled "Created" (the row-count and the date collide).
- **Problem:** an operator can't see how long a job took, whether it balances, or do anything about it; the duplicate "Created" header is a real readability bug.
- **Enterprise best practice:** Fivetran/Census run rows show duration, full outcome breakdown, and a per-run action menu.
- **Recommended implementation:** rename the date column "Submitted"; add "Duration" (`completedAt − startedAt`) and a reconciliation chip; add a row `…` menu (View errors / Retry / Re-scan) gated by `canMaybe("imports:operate")`; keep four-state `StateSwitch`.
- **Expected impact:** the monitor becomes a triage console, not a flat ledger; fixes the header collision.
- **Dependencies:** 6.1 (columns), 5.1–5.3 (actions), `imports:operate` cap.
- **Priority:** Medium

### 12.2 Tenant entity-picker filter (Phase-1 quick win)

- **Current state:** no filtering.
- **Problem:** isolating one tenant's imports is impossible.
- **Enterprise best practice:** typeahead entity-pickers over free-text ids across all admin consoles.
- **Recommended implementation:** reuse the shared tenant entity-picker (Phase-1 program component) wired to the 5.4 filtered read; status/AV facets as enum dropdowns (not free text).
- **Expected impact:** fast triage; consistent with sibling tabs gaining the same picker.
- **Dependencies:** shared entity-picker; 5.4 backend filters.
- **Priority:** Medium

## 13. Automation Opportunities

- **Alert on `infected` / `failed` / non-balancing jobs.** A worker watch that emits a PagerDuty/Slack alert when an `import_jobs` row reaches `avScanStatus='infected'` or `status='failed'` (Fivetran "Failed Records"-style). Feeds §14. **Priority: High.**
- **Auto-redrive transient DLQ entries.** A bounded auto-retry for DLQ records whose `failedReason` matches a transient-error allow-list (with a hard attempt ceiling + audit), distinct from data-error failures that must stay manual. **Priority: Medium.**
- **Recurring-import scheduling visibility (G10).** If/when recurring imports land, surface schedule + next-run; out of scope until the pipeline supports them. **Priority: Low.**
- **Reconciliation-mismatch sweep.** A periodic check asserting `rows_in = succeeded + rejected + deduped + unprocessed` per completed job and flagging drift (doc 30 §4 makes this an alert-worthy invariant). **Priority: Medium.**

## 14. Monitoring & Logging

- **Audit (today).** Every load records `admin.list_import_jobs` via `withPlatformTx` → `platform_audit_log` (raw table, owner connection). Proposed reads add `admin.list_import_job_rejects` / `admin.list_import_dlq` / `admin.list_export_jobs`; proposed writes add `import_job.retry` / `.rescan` / `.tombstone` to the `platformAuditAction` enum + `platformAuditCoverage.test.ts` (PENDING→WRITTEN drift guard).
- **Metrics to add.** Per-tenant import volume, reject rate, AV-infected count, time-to-complete (p50/p95), DLQ depth, queue lag for `imports`/`bulk-imports`. Emit from the worker; expose on `/system-health` and (read-side) the monitor.
- **Logging.** The reject drill-down should reduce reliance on Sentry — but worker-side structured logs (job id, chunk, tenant, outcome counts; **no PII**) remain the deep-debug source. Correlate by `import_jobs.id`.
- **Dashboards.** A Datadog/Grafana board for import throughput + failure rate + DLQ depth, mirroring the Fivetran Platform Connector's warehouse-landed sync logs pattern.

## 15. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Drill-down leaks raw PII from `import_job_rows.input` | Medium | Critical | Return reason + index only; mandatory security review; response Zod schema (8.2) |
| `tombstone`/`rescan` destroys/alters a quarantine object wrongly | Low | High | Elevation-gated, audited, confirm dialog; soft-tombstone (mark + delayed delete) |
| Cross-tenant read regresses without `created_at` index at scale | Medium | Medium | Add index 7.1 before `import_jobs` grows |
| Retry double-enqueues on double-click | Medium | Medium | Idempotency-Key (deferred) + reuse `import_jobs.idempotencyKey` |
| Export-jobs monitor built before export pipeline exists | Low | Medium | Sequence after doc 30 §6–8 ships |
| New `imports:operate` cap over-granted | Low | Medium | Grant narrowly (support + super_admin); per-request `requireCapability` re-check |

## 16. Technical Debt

- **Duplicate "Created" column header** in `ImportsMonitorPage.tsx` (row-count vs date) — a real UI bug; rename on first touch (12.1).
- **No response Zod schema** on `/import-jobs` — fine now, fragile as columns grow (8.2).
- **Rich `import_jobs` state unused** — the repo selects 13 of ~25 columns; `conflictPolicy`, chunks, `rowsUnprocessed`/`rowsDeduped`, `fileSize`, `rejectedArtifactKey` are modelled but invisible (G8).
- **No capability for the tab** — role-list gating duplicated across siblings instead of the capability layer the rest of the console moved to (G7).
- **`import_job_rows` partitioning intent recorded but unbuilt** (7.2) — documented debt, not a silent drop.
- **DLQ write with no read** — `deadLetterFailedImport` produces records nothing consumes (6.2).

## 17. Multi-Phase Implementation Plan

### Phase 1 — UX/correctness quick wins (Priority: High)

- **Objectives:** make the existing monitor a usable triage tool without new mutations or infra.
- **Scope:** frontend + read-path backend only; no writes.
- **Deliverables:** fixed "Created" header collision; Duration + reconciliation + unprocessed/deduped columns; tenant entity-picker + status/AV enum-dropdown filters; `imports:read` capability and read moved to `requireCapability("imports:read")`.
- **Technical tasks:** extend `recentImportJobs` select + `ImportJobRow` (6.1); add `{tenantId,status,avScanStatus,since}` + keyset cursor (5.4); add `imports:read` to `staffCapability`/`ROLE_CAPABILITIES`; wire entity-picker (12.2); add `idx_import_jobs_created_at` (7.1).
- **Risks:** column-leak via wider select → add response Zod (8.2) here.
- **Dependencies:** shared entity-picker (program Phase-1 component).
- **Testing requirements:** repo itest for filters + cap clamp; capability gate test; `format.ts` unit tests; four-state render test.
- **Estimated complexity:** Low–Medium.
- **Success criteria:** an operator filters to one tenant's failed imports and reads the full balanced tally without leaving the console; read gated by capability.

### Phase 2 — Drill-down + DLQ visibility (Priority: High)

- **Objectives:** answer "why did these rows fail?" and "what died?" in-product.
- **Scope:** read-only drill-down + DLQ read (still no destructive mutation).
- **Deliverables:** `GET /import-jobs/:jobId/rejects` drawer (reason + index, no PII); `GET /import-jobs/dlq` view.
- **Technical tasks:** `importJobRejectSample` repo (5.1); DLQ read via Redis producer (6.2); `admin.list_import_job_rejects` / `admin.list_import_dlq` read actions; `Drawer` UI.
- **Risks:** PII leakage from `input` jsonb — **hard security gate**; unbounded `import_job_rows` scan → `LIMIT` + `idx_import_job_rows_job`.
- **Dependencies:** Phase 1; truepoint-security PII review; Redis producer access from apps/api.
- **Testing requirements:** itest asserting `input` is never selected; DLQ read mock; bounded-limit test.
- **Estimated complexity:** Medium.
- **Success criteria:** staff debug a failed import end-to-end in-console; no PII crosses the boundary in any path.

### Phase 3 — Audited operator actions (Priority: High, flag-gated)

- **Objectives:** give operators safe, audited remediation: retry, re-scan, tombstone.
- **Scope:** the first **mutations** on this tab; full audited-mutation recipe each; elevation-gated.
- **Deliverables:** `POST /import-jobs/:jobId/{retry,rescan,tombstone}`; `import_job.retry|rescan|tombstone` audit actions; row `…` action menu gated by `canMaybe("imports:operate")`.
- **Technical tasks:** add `imports:operate` cap; `requeueImportJob`/`rescanImportJob`/`tombstoneImportJob` on `platformAdminWriteRepository`; enum + `platformAuditCoverage` PENDING→WRITTEN; `withPlatformTx` routes consuming a JIT elevation; kill-switch flag `platform.imports.actions`; confirm dialogs.
- **Risks:** destructive `tombstone`; double-enqueue (Idempotency-Key deferred — interim: reuse `idempotencyKey`); over-granted cap.
- **Dependencies:** Phases 1–2; JIT elevation; AV scanner + object-store delete creds; **truepoint-security + infra sign-off**.
- **Testing requirements:** audit-coverage drift test; elevation-required 403 itest; idempotent-retry test; isolation test (action scoped to the job's tenant).
- **Estimated complexity:** Medium–High.
- **Success criteria:** an operator recovers a transient failure and tombstones an infected upload, each audited + elevation-gated, behind a flag.

### Phase 4 — Export-jobs symmetry + deferred security depth (Priority: Medium, flag-heavy)

- **Objectives:** close ADR-0036's export half and land the deferred platform-security items.
- **Scope:** new `export_jobs` table + monitor; Idempotency-Key on mutations; alerting/automation.
- **Deliverables:** `export_jobs` table (+ RLS deny-all + REVOKE), `GET /admin/export-jobs`, `apps/admin/src/features/exports/*`; Idempotency-Key on imports mutations; infected/failed alerting + bounded auto-redrive.
- **Technical tasks:** new-platform-table recipe for `export_jobs`; `recentExportJobs` repo; `admin.list_export_jobs`; idempotency key table + header handling (platform-wide decision); alert worker + reconciliation sweep (§13).
- **Risks:** export pipeline must exist first; Idempotency-Key is a platform-wide deferred decision; alert noise.
- **Dependencies:** doc 30 §6–8 export pipeline; platform idempotency sign-off; truepoint-security on signed-link export governance.
- **Testing requirements:** export RLS deny-all test; idempotency replay test; alert-trigger test.
- **Estimated complexity:** High.
- **Success criteria:** exports have the same audited monitor as imports; mutations are replay-safe; staff are alerted on infected/failed imports.

## 18. Final Recommendations

- **Build the operability layer the monitor implies (Phase 1→3).** The read foundation is correct and PII-safe; its value is throttled by having zero actions. Filters + drill-down + retry/rescan, each gated by a new `imports:read`/`imports:operate` capability and (for mutations) a JIT elevation, convert a flat ledger into the triage console Fivetran/Salesforce operators expect. **Priority: High.**
  - **Current state:** read-only monitor, role-gated, no actions/filters/drill-down. **Problem:** every failure investigation leaves the product (Sentry/SQL) and there's no in-console recovery. **Enterprise best practice:** Bulk-API/Fivetran/Census job monitors with per-row errors + one-click re-run. **Recommended implementation:** Phases 1–3 above. **Expected impact:** import incidents resolved in-console, fully audited, no PII exposure. **Dependencies:** entity-picker, `imports:*` caps, JIT elevation, AV/object-store creds. **Priority:** High.
- **Treat the per-row drill-down as a security gate, not a feature.** `import_job_rows.input` is raw PII; the drill-down must return reason + index only and pass a mandatory truepoint-security review. **Priority: High (Critical if mishandled).**
  - **Current state:** no drill-down. **Problem:** the only data that answers "why?" sits next to raw PII. **Enterprise best practice:** Salesforce `failedResults` exposes per-row error without the source-sensitive fields the customer didn't request. **Recommended implementation:** §5.1 with the PII constraint enforced by a response schema + itest. **Expected impact:** debuggability with zero PII boundary crossing. **Dependencies:** truepoint-security sign-off. **Priority:** High.
- **Add the `imports:*` capabilities now, before any action lands.** The tab is the last read-only console still role-gated; the capability layer is a prerequisite for Phase 3 and for the `canMaybe` render-gates. **Priority: High.**
  - **Current state:** `requireStaffRole` only, no capability. **Problem:** action gating would otherwise duplicate role-lists per endpoint. **Enterprise best practice:** Okta/Azure-AD granular, per-action entitlements. **Recommended implementation:** add `imports:read`/`imports:operate` to `staffCapability` + `ROLE_CAPABILITIES`; move the read to `requireCapability`. **Expected impact:** consistent, revocable, per-request-checked gating. **Dependencies:** none. **Priority:** High.
- **Defer, but spec, the export monitor, Idempotency-Key, and auto-redrive.** Export-jobs needs the export pipeline; Idempotency-Key is a platform-wide decision; auto-redrive needs a transient-error taxonomy. All three are designed above and must NOT be claimed as built. **Priority: Medium — needs infra/platform sign-off.**
  - **Current state:** none exist. **Problem:** export has zero oversight (higher PII risk than import); retries aren't replay-safe. **Enterprise best practice:** OneTrust export audit; idempotent ingest APIs. **Recommended implementation:** §8.1, §10 Idempotency-Key spec, §13 auto-redrive. **Expected impact:** symmetric, replay-safe, alerting pipeline. **Dependencies:** export pipeline (doc 30), platform idempotency decision, security sign-off. **Priority:** Medium.

> **Net:** the Bulk Imports tab is a correct, privacy-conservative read foundation that stops one step short of being operable. Phase 1–2 (filters + PII-safe drill-down + DLQ visibility) are high-value, low-risk, and unblock real triage; Phase 3 (audited, elevation-gated actions) is where it becomes an incident-response tool; Phase 4 closes ADR-0036's export half and the deferred security depth. Nothing here weakens the existing tenant-isolation/PII posture — every recommendation is built to preserve it.
