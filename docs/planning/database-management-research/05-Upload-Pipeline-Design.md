# 05 — Upload-Pipeline Design

> **Series:** [Database Management](./README.md) · **Type:** Design · **Status:** ✅ Authored · **Prev:** [`04-Control-Panel-Architecture`](./04-Control-Panel-Architecture.md) · **Next:**
> [`06-Data-Validation-Framework`](./06-Data-Validation-Framework.md)

---

## 1. Objective

Specify the **end-to-end upload / import pipeline** for both TruePoint surfaces, and the concrete
plan to **enable-and-harden** the already-built-but-**Dark** bulk `COPY`-staging pipeline so it can
be flipped on per-tenant behind its existing flags.

Two surfaces, one engine:

- **Surface 1 — Internal Staff Console** (`apps/admin`, Data management → *Imports & Uploads*): a
  cross-tenant **operator** view that monitors every workspace's imports and drives the four
  operator transitions — **retry chunk / pause / resume / cancel** — through new
  `/api/v1/admin/data/imports/*` endpoints, each `withPlatformTx`-audited.
- **Surface 2 — Customer Self-Service** (`apps/web`, `features/data-health` → import wizard): a
  workspace-scoped, RLS-enforced wizard a customer drives over their **own** data.

Both compose the **same** server-owned `import_jobs` state machine, the **same** `@leadwolf/core`
staging primitives, and the **same** `apps/workers` consumers. This document is the
**`05` upload spec**; the column-mapping / row-level validation rules that gate the *preview* step
live in [`06-Data-Validation-Framework`](./06-Data-Validation-Framework.md); the match/dedup the
chunk runner invokes after promote lives in
[`07-Deduplication-and-Linking`](./07-Deduplication-and-Linking.md).

The pipeline is the **MVP / Phase 0 (Observe & Enable)** centerpiece of the
[`14-Implementation-Roadmap`](./14-Implementation-Roadmap.md): the import drill-down is read-only
Phase 0, and *enable-and-harden the dark bulk import* is the one net-new write Phase 0 ships.

This doc applies enterprise dimensions **1** (data ingestion), **2** (bulk uploads), **3** (import
pipelines), **17** (background jobs / webhook completion), **18** (queue management), and **19**
(error handling) from [`02-Enterprise-Research`](./02-Enterprise-Research.md#4-best-practices-by-dimension).

---

## 2. Current Challenges

| # | Challenge | Status today | Evidence |
|---|---|---|---|
| C1 | The **sync** import path parses on the request thread — fine at ~5k rows, falls over on a 500k-row CSV (memory + request-timeout). | Sync = **Shipped**; no async hand-off in prod. | `BULK_IMPORT_THRESHOLD_ROWS` default 5000 at `packages/config/src/env.ts:184` exists but the bulk lane it routes to is Dark. |
| C2 | The **bulk `COPY`-staging** engine is fully written but **Dark** — it creates/enqueues nothing in prod. | **Dark**, double-gated. | `bulkRoutes.ts:53-58` (env kill-switch) + `:145-149` (per-tenant flag); `env.ts:174` `BULK_IMPORT_ENABLED` default false. |
| C3 | The one load-bearing primitive — `COPY … FROM STDIN` streaming over `postgres.js` — is **UNVERIFIED**. The repo has zero prior `COPY`/`.writable()` usage. | **Unverified.** | The banner box at `importStagingRepository.ts:10-17`. |
| C4 | There is **no production object store**. Only a dev local-disk adapter exists (no signing, no isolation). | **Missing.** | `fileStore.ts:7` ("never wire it in production"); `BULK_IMPORT_STORAGE_DIR` at `env.ts:181`. |
| C5 | No **operator transitions**. Staff can read `import_jobs` (`GET /admin/import-jobs`, read-only monitor) but cannot retry a stuck chunk, pause/resume, or cancel a runaway job. | **Missing.** | `apps/admin/src/features/imports/api.ts:15-21` is read-only; no admin import write routes. |
| C6 | No **AV scanner** is wired; uploads are recorded `avScanStatus='skipped'`. | **Partial (seam only).** | `bulkRoutes.ts:126-128` `scanUpload()` returns `"skipped"`. |
| C7 | No **webhook completion** — Surface-2 self-service has no way to be told a very large async load finished except by polling. | **Missing.** | `GET /imports/bulk/:jobId` poll only; `bulkRoutes.ts:231`. |
| C8 | The `import_job_rows` per-row ledger is denormalized + indexed but there is **no drill-down UI** over chunks/rows/rejects. | **Missing (UI).** | Schema present (`importJobs.ts:122-156`); no admin feature folder reads it. |

See [`01-Current-State-Analysis`](./01-Current-State-Analysis.md#10-status-summary-the-one-table-to-remember) §10 and
the gap IDs in [`03-Gap-Analysis`](./03-Gap-Analysis.md) for the canonical register.

---

## 3. Enterprise Best Practices (cited)

Drawn from [`02-Enterprise-Research`](./02-Enterprise-Research.md); citations link to that doc's
dimension sections.

- **Dim 1 — Data ingestion** ([`02 §1`](./02-Enterprise-Research.md#41-data-ingestion)): a
  *server-owned* job with an *explicit state machine*; **closing the job TRIGGERS processing**
  (Salesforce Bulk API 2.0); get-job-info returns `processed / failed / total`; plan for **eventual
  consistency (~30s)**; surface *processed-vs-available*. → our `import_jobs.status` machine + the
  `staged → running` trigger + the eight `rows_*` counters.
- **Dim 2 — Bulk uploads** ([`02 §2`](./02-Enterprise-Research.md#42-bulk-uploads)): cap **sync**
  endpoints to a *response-size budget* (PDL ~1 MB ⇒ ~50/call); route big loads to **file-async**;
  **fail-fast header/schema check**; bounded output-download window. → our `BULK_IMPORT_THRESHOLD_ROWS`
  promotion + the upfront header/schema verdict (step 3 of the wizard).
- **Dim 3 — Import pipelines** ([`02 §3`](./02-Enterprise-Research.md#43-import-pipelines)): **atomic
  phases + recovery points**; *resume from checkpoint*; transactionally-staged drain +
  **completer/reaper** workers; **staging-table-then-promote**; mapping/validation as **visible UI
  steps before persist**; idempotency keys (brandur.org). → our `byte_offset` watermark,
  `runBulkImport` resume, `finalizeIfLastChunk` completer, the UNLOGGED staging table.
- **Dim 17 — Background jobs** ([`02 §17`](./02-Enterprise-Research.md#417-background-jobs)): async +
  **webhook completion** (cheap sync ack → webhook for expensive results); **idempotent receivers**;
  reserve async+webhook for very large batches (Apollo bulk). → 202 + jobRef now; webhook on terminal.
- **Dim 18 — Queue management** ([`02 §18`](./02-Enterprise-Research.md#418-queue-management)): a
  **dedicated bulk lane below interactive** (Apollo bulk ~50% of the single-endpoint limit);
  multi-window limits + quota/reset headers + 429; anticipate **parent-lock contention**
  (sort/serial/small-batch/retry). → the separate `bulk-imports` queue + chunk ordering by
  `source_row_num`.
- **Dim 19 — Error handling** ([`02 §19`](./02-Enterprise-Research.md#419-error-handling)): **never
  fail the whole batch** → per-record status array + **separate failed-results artifact** + echoed
  correlation token; **idempotency keys replay the first response incl. failures**; backoff+jitter on
  429/5xx; **partial-accept vs whole-file reject by sensitivity**; row-level error report (PDL bulk).
  → `import_job_rows.outcome` ledger + the `rejected-rows.csv` artifact + the `partial` terminal
  status.

---

## 4. Gaps in Current Implementation

Mapped to the dims above; tier per the canonical tiering in
[`03-Gap-Analysis`](./03-Gap-Analysis.md) and [`14-Implementation-Roadmap`](./14-Implementation-Roadmap.md).

| Gap | Dim | Status | Tier | What's missing |
|---|---|---|---|---|
| G-UP-1 **Verify `copyRows`** | 3 | Dark/Unverified | **Phase 0** | A Bun+PG spike proving `ownerClient.unsafe(<COPY>).writable()` returns a backpressure-aware Writable, the CSV encoding round-trips byte-for-byte, and bytea reads back as Buffer (`importStagingRepository.ts:11-17`). |
| G-UP-2 **Prod object store** | 2 | Missing | **Phase 0** | An S3-class `FileStore` adapter (presigned multipart, AV-scan-before-promote, signed+expiring download) replacing `diskFileStore` (`fileStore.ts`). |
| G-UP-3 **Idempotency confirm** | 19 | Partial | **Phase 0** | Confirm `(workspace_id, idempotency_key)` ws-unique replay + a `content_hash`-based exact-file dedup pre-check (`importJobs.ts:77-79`). |
| G-UP-4 **Import drill-down** | 1 | Missing | **Phase 0** | Read-only chunks/rows/rejects view over `import_job_rows` (`importJobs.ts:122`). |
| G-UP-5 **Operator transitions** | 18 | Missing | **Phase 0→1** | retry-chunk / pause / resume / cancel endpoints under `/admin/data/imports/*`, each `withPlatformTx`-audited. |
| G-UP-6 **AV scanner** | 2 | Seam only | **Phase 1** | A real scanner injected at `scanUpload()` (`bulkRoutes.ts:126`). |
| G-UP-7 **Webhook completion** | 17 | Missing | **Phase 2** | A `data.import.completed` webhook fired on terminal status (Surface 2). |
| G-UP-8 **Self-service wizard** | 2,3 | Partial | **Phase 2** | Extend `apps/web` ImportWizard into the data-health control panel. |

---

## 5. Recommended Solution

### 5.1 The `import_jobs` state machine (server-owned, explicit)

The job is the unit of recovery (dim 1, dim 3). `status` is a `varchar(30)` with a DB `CHECK`
enum (`importJobs.ts:80-83`): `queued → validating → staged → running → (paused) →
completed | partial | failed | cancelled`.

```
   POST /imports/bulk            worker DRIVE picks up
   (202 + jobRef)                createStagingTable + bulkStage
        │                              │
        ▼                              ▼
   ┌─────────┐  enqueue drive   ┌────────────┐  COPY+dedup done   ┌────────┐
   │ queued  │ ───────────────▶ │ validating │ ─────────────────▶ │ staged │
   └─────────┘                  └────────────┘                    └───┬────┘
        │                            │  stage throws / AV infected    │ fan out
        │ cancel                     ▼                                │ chunk jobs
        │                       ┌────────┐                            ▼
        │                       │ failed │◀──────────┐          ┌─────────┐
        │                       └────────┘  unrecov. │  ┌──────▶│ running │
        ▼                                            │  │ resume└────┬────┘
   ┌───────────┐                                     │  │            │ last chunk
   │ cancelled │◀────────── cancel (any non-terminal)│  │            │ finalizeIfLastChunk
   └───────────┘                                     │  │            ▼
                                  pause │  ▲ resume  │  │   ┌──────────────────────┐
                                        ▼  │         │  │   │ completed  (0 rejected)│
                                   ┌────────┐        │  │   │ partial (≥1 rejected/  │
                                   │ paused │────────┘  └──▶│          unprocessed)  │
                                   └────────┘ retry chunk   └──────────────────────┘
```

**Transition rules** (enforced server-side; the client status string is never trusted):

| From | Event | To | Who | Notes |
|---|---|---|---|---|
| `queued` | worker DRIVE starts | `validating` | worker | `runBulkImport` → `updateJobStatus(validating, startedAt)` (`runBulkImport.ts:120-122`). |
| `validating` | stage OK | `staged` | worker | `updateJobStatus(staged, stagingTable, totalChunks)` (`runBulkImport.ts:146-151`). |
| `validating` | AV `infected` / stage throws | `failed` | worker | `failedReason` set; staging dropped. |
| `staged` | chunks enqueued, first runs | `running` | worker | Chunk runner flips on claim. |
| `running` | last chunk done, 0 rejected | `completed` | worker | `finalizeIfLastChunk` (`runBulkImport.ts:218-220`). |
| `running` | last chunk done, ≥1 rejected/unprocessed | `partial` | worker | Same call; `partial` is success-with-rejects. |
| `running`/`staged`/`queued`/`paused` | **operator pause** | `paused` | **staff** | new `POST /admin/data/imports/:jobId/pause`; sets job + open chunks `paused`. |
| `paused` | **operator resume** | `running` (or back to `staged`) | **staff** | re-enqueues non-`completed` chunks via `runBulkImport` resume branch (`runBulkImport.ts:94-110`). |
| `paused`/`running` | **operator retry chunk** | `running` | **staff** | re-enqueues one `failed`/`partial` chunk (`POST …/chunks/:chunkId/retry`). |
| any non-terminal | **operator cancel** | `cancelled` | **staff** | `POST …/cancel`; drops staging, stops fan-out. |

Terminal states = `{completed, partial, failed, cancelled}`. `paused` and `validating`/`staged`/
`running` are non-terminal. Operator transitions are **idempotent** (re-issuing `pause` on a
`paused` job is a 200 no-op).

### 5.2 The `COPY`-staging architecture (why it exists, how it isolates)

Bulk load cannot go through `withTenantTx`/`leadwolf_app` because **Postgres forbids `COPY` on an
RLS-enabled table**. The pipeline therefore:

1. Creates a **per-job `UNLOGGED`, NON-RLS staging table** `stg_import_<jobId>` at **runtime** (not
   in a migration) on the **owner connection** (`importStagingRepository.ts:189-224`). `UNLOGGED` =
   no WAL (fast load; lost on crash — acceptable, because the file in the object store is the source
   of truth and stage is re-runnable).
2. `COPY … FROM STDIN WITH (FORMAT csv)` streams prepared rows through a backpressure-aware Node
   `Writable` in **constant memory** (`importStagingRepository.ts:231-243`). PII is **already
   encrypted** before it hits staging (`email_enc`/`phone_enc` bytea + blind index + `content_hash`);
   only `raw_data` jsonb is transient plaintext, dropped on finalize.
3. Because the staging table is **non-RLS**, the **only** isolation is the **explicit `workspace_id`
   predicate** every staging read carries (`readChunkBand` `WHERE workspace_id = $1`,
   `importStagingRepository.ts:284`). A forgotten predicate would leak across workspaces — so **all**
   staging access is confined to this one repository, and the owner connection is exported **only**
   for it (`client.ts:19-27`).

> **Security precedence.** This is the single sanctioned RLS-bypass write path in the import system.
> It is safe **only** because (a) PII is encrypted at rest in staging, (b) every query carries the
> `workspace_id` access-path predicate, (c) the table name is uuid-validated before interpolation
> (`importStagingRepository.ts:97-102` — the one place untrusted-looking text touches a
> non-parameterizable identifier), and (d) it never touches a tenant-scoped (overlay) table. The
> **promote step** (chunk runner writing `contacts`) runs back inside `withTenantTx` — RLS-enforced,
> ownership-checked. A staging read that dropped the `workspace_id` predicate is a **bug, not a style
> choice**.

### 5.3 The three enable-gates (the only thing standing between Dark and per-tenant GA)

**Gate A — Verify `copyRows` (Bun+PG spike).** Stand up a real Postgres, run the §6.4 spike
(`importStagingRepository.ts:11-17`): prove (1) `ownerClient.unsafe(<COPY … FROM STDIN>).writable()`
returns a backpressure-aware Node `Writable`; (2) the CSV encoding (bytea as unquoted `\x<hex>`; NULL
as unquoted empty field; jsonb/text quoted with internal quotes doubled) round-trips byte-for-byte;
(3) bytea columns read back as `Buffer`. Until green, `BULK_IMPORT_ENABLED` stays false.

**Gate B — Production object store adapter.** Implement an S3-class `FileStore` at the
`apps/api`/`apps/workers` composition root (NOT in `@leadwolf/core` — core stays AWS-SDK-free,
`fileStore.ts:4-7`). It must satisfy the existing port verbatim:

```ts
// packages/core/src/storage/fileStore.ts:23 — the port the prod adapter implements
export interface FileStore {
  putObject(key: string, body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | Uint8Array): Promise<void>;
  getObjectStream(key: string): Promise<AsyncIterable<Uint8Array>>; // constant-memory read for stream-parse
  putArtifact(key: string, bytes: Uint8Array): Promise<void>;       // rejected-rows.csv
  getSignedDownloadUrl(key: string): Promise<string>;               // signed + EXPIRING in prod
}
```

Prod adapter requirements (dim 2): **presigned multipart** upload, **AV-scan-before-promote**, a
**signed, expiring** download URL (a bounded output-download window), and SSE-KMS at rest. Inject it
via `bulkFileStore()` (`bulkRoutes.ts:37`) selected on `NODE_ENV`/config — dev keeps `diskFileStore`.

**Gate C — Idempotency confirmation.** Two layers, DB-enforced:
- **Submit replay:** the partial-unique `(workspace_id, idempotency_key)` index (`importJobs.ts:77-79`)
  collapses a re-submitted `Idempotency-Key` onto the existing job — `createJob` returns
  `{id, created:false}` and the route skips the re-upload + re-enqueue (`bulkRoutes.ts:186-222`). The
  poll then reflects wherever the original job already is (replay-the-first-response, dim 19).
- **Exact-file dedup:** confirm `content_hash` (per-row, `bulkStage.ts:126`) plus a job-level file
  hash so an identical file re-uploaded **without** an idempotency key is detected and offered as
  "this looks identical to job X" rather than silently double-loaded.

### 5.4 Chunking + the completer/reaper pattern

- **DRIVE** (`runBulkImport`) stages, plans `~CHUNK_ROWS` (10 000) bands over `[0, total)`
  (`runBulkImport.ts:22-23, 73-79`), creates all chunk rows in **one** tx, then enqueues each band
  **after commit** so a worker never races a not-yet-visible chunk (`runBulkImport.ts:171-188`).
- **Chunk runner** (`bulkProcessChunk`) reads its band's **pending survivors** under the
  `workspace_id` predicate, promotes them into `contacts` inside `withTenantTx` (RLS-enforced), runs
  against-existing dedup, and writes the per-row `import_job_rows` ledger.
- **COMPLETER** (`finalizeIfLastChunk`, `runBulkImport.ts:207-232`) atomically does
  `completed_chunks += 1`; when it reaches `total_chunks` it flips the job terminal and drops staging.
  Returns `{finalized, fireRollups}` so the worker fires the dedup / firmographics / masterBackfill
  rollups **exactly once** (matches the on-completed fan-out in `apps/workers/src/register.ts`).
- **REAPER** (net-new, Phase 0/1): a leader-locked scheduled sweep (pattern of the existing
  `*-sweep` queues + `leaderLock.ts`) that finds chunks stuck `running` past a lease deadline
  (`attempts` exhausted, `completed_at` null) and re-enqueues or marks them `failed`, so a crashed
  worker can't wedge a job forever. This is the operator-facing safety net behind *retry chunk*.

### 5.5 Webhook / async completion for very large loads (dim 17)

Surface 2 returns **202 + jobRef** immediately (cheap ack). For very large loads the customer
registers a webhook; on terminal status the worker fires `data.import.completed` carrying
`{jobId, status, counts, rejectedRowsUrl}` through the existing `/api/v1/webhooks` delivery path
(idempotent receiver; sender retries with backoff+jitter). Polling `GET …/:jobId` remains the
fallback. Staff (Surface 1) do not need webhooks — the console live-polls.

---

## 6. Implementation Steps (sequenced)

1. **Gate A spike** — write `scripts/spikes/copy-spike.ts`; run on real PG under Bun; assert the
   three `copyRows` properties. Capture results in an ADR addendum. *(Phase 0; unblocks everything.)*
2. **Gate B adapter** — `apps/api/src/features/import/s3FileStore.ts` implementing `FileStore`;
   wire `bulkFileStore()` to choose disk-vs-S3 on config; add `BULK_IMPORT_S3_*` env. *(Phase 0.)*
3. **Gate C** — add a job-level file-hash column check + the "identical file" pre-flight response;
   integration-test the `(workspace_id, idempotency_key)` replay. *(Phase 0.)*
4. **Reaper sweep** — register `bulk-import-reaper-sweep` (leader-locked) in
   `apps/workers/src/register.ts`; lease/attempts logic on `import_job_chunks`. *(Phase 0/1.)*
5. **Admin read-only drill-down** — new `apps/admin` feature folder `features/data-imports/`
   (mirror `features/imports/`), reading `GET /admin/data/imports`, `…/:jobId`,
   `…/:jobId/chunks`, `…/:jobId/rows`. New capability `data:read`. *(Phase 0.)*
6. **Operator transition endpoints** — `POST …/:jobId/{pause,resume,cancel}` and
   `…/chunks/:chunkId/retry` under `apps/api/src/features/admin/data/imports.ts`; each
   `withPlatformTx`-audited, `requireCapability("data:manage")`, mandatory justification reason.
   *(Phase 0→1.)*
7. **Operator UI** — wire the four transition buttons into the admin drill-down (Dialog + reason +
   `useToast`, mirroring `TenantActions.tsx`). *(Phase 1.)*
8. **AV scanner** — inject a real scanner at `scanUpload()`; refuse `infected` before job create.
   *(Phase 1.)*
9. **Self-service wizard + webhook** — extend `apps/web` ImportWizard into `features/data-health`;
   fire `data.import.completed`. *(Phase 2.)*
10. **Flip the gates** — env `BULK_IMPORT_ENABLED=true`, then per-tenant `bulk_import_enabled`
    canary → GA. *(Per §12.)*

---

## 7. UI/UX Requirements

### 7.1 Surface 1 — Staff Imports & Uploads console (operator)

A new **Data management → Imports & Uploads** destination (`navConfig.ts` `DESTINATIONS`). Two-pane:
a cross-tenant **DataTable** of jobs, drilling into a **Drawer** with chunk/row/reject tabs and the
four operator actions. Mirrors `features/imports` (read) + `features/retention` (tabs + write) +
`TenantActions.tsx` (Dialog + reason).

```
┌─ TruePoint Admin · Data management ▸ Imports & Uploads ──────────────────────────────┐
│ [ Status ▾ ]  [ Tenant ▾ ]  [ Source ▾ ]            search jobs…   [⟳]   (live ●)     │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ Tenant        Source file          Status      Rows  Created Matched Rej   Updated  ▸ │
│ Acme (ws-12)  q2-leads.csv         ● running   482k  310k    140k    1.2k  2m ago   ▸ │
│ Globex (ws-3) sept-import.xlsx     ◐ partial   50k   48k     0       2k    1h ago   ▸ │
│ Initech       crm-dump.csv         ⏸ paused    1.1M  220k    —       —     5m ago   ▸ │
│ Umbrella      bad-headers.csv      ✕ failed     —    —       —       —     3m ago   ▸ │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ ▸ DRAWER: Acme · q2-leads.csv · job 0f3c… (running 64%)        [Pause] [Cancel]       │
│   StatTiles: Total 482k · Created 310k · Matched 140k · Duplicate 30k · Rejected 1.2k │
│   ┌ Tabs: [ Chunks ] [ Rows ] [ Rejects ] ──────────────────────────────────────────┐ │
│   │ Chunk  Band            Status     Attempts  Rows   Completed                       │ │
│   │ #31    310000–320000   ● running  1         —      —                  [Retry]      │ │
│   │ #30    300000–310000   ✕ failed   3         0      —                  [Retry]      │ │
│   │ #29    290000–300000   ✓ done     1         10000  2m ago                          │ │
│   └────────────────────────────────────────────────── Pagination (keyset) ──────────┘ │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

**@leadwolf/ui components:** `DataTable` + `Column<T>` (sortValue/rowKey), `StatusBadge` +
`StatusTone` (running=info, partial=warn, failed=danger, completed=success, paused=neutral,
cancelled=muted), `StatTile` (counters), `Drawer` (job detail), `Tabs` (Chunks|Rows|Rejects),
`Pagination` (keyset), `TpButton` (Pause/Resume/Cancel/Retry), `Dialog` + `TpTextarea` (mandatory
justification reason), `ToastProvider/useToast`, `Combobox`/`TpSelect` (filters), `Tooltip`,
`Card`, `Icon`.

**The four states** (via `StateSwitch`):
- **loading** — `LoadingState` / `Skeleton` rows in the table; tiles show shimmer.
- **empty** — `EmptyState` "No imports in the selected window" + a filter-reset action.
- **error** — `ErrorState` rendering `problemMessage(res, …)` (RFC-7807 detail/title) + retry.
- **data** — the table + drawer above; live re-poll badge in the header.

The operator-action confirm: `Dialog` with a **mandatory reason** `TpTextarea` (empty submit
disabled), echoing the worst-case effect ("Cancelling will stop ~262k unprocessed rows; promoted
contacts are kept"); on success `useToast` success; on `ForbiddenError` (missing `data:manage` /
elevation) `useToast` danger.

### 7.2 Surface 2 — Customer self-service import wizard

The five-step wizard inside `apps/web` `features/data-health` (RLS-scoped, `requireOrgRole`):

```
 ① Upload ──▶ ② AV scan ──▶ ③ Map columns ──▶ ④ Preview & validate ──▶ ⑤ Commit
 drop CSV     "Scanning…"    header→field      [06] reject summary       202 + jobRef
 /XLSX        clean/infected  + templates       sample first 50 rows      poll / webhook
```

- **③ Map columns** uses saved **mapping templates** (`GET /imports/mapping-templates`); the
  fail-fast header/schema verdict (dim 2) blocks `Next` on a missing required column.
- **④ Preview & validate** is the gate owned by
  [`06-Data-Validation-Framework`](./06-Data-Validation-Framework.md) — it shows the row-level reject
  tiers (the multi-valued email status, catch-all/unknown as distinct risk) **before** any persist.
- **⑤ Commit** posts the multipart upload (`Idempotency-Key` header), returns 202, and the
  data-health dashboard shows the live job card. Same four states via `StateSwitch`.

---

## 8. Database & Backend Changes

### 8.1 Reused, no new core tables

The control/ledger trio already exists and is sufficient (`packages/db/src/schema/importJobs.ts`,
migration **0032**):

- **`import_jobs`** — control row. Reuse **as-is**: `status` (the 9-state enum, `:80-83`),
  `av_scan_status`, `idempotency_key` (ws-unique, `:77-79`), `column_mapping`, `conflict_policy`,
  `target_list_id`, `staging_table`, `byte_offset` (resume watermark, `:56`), `total_chunks` /
  `completed_chunks`, the eight `rows_*` counters, `rejected_artifact_key`, `failed_reason`.
- **`import_job_chunks`** — work partition. Reuse: `chunk_index`, `row_start`/`row_end`, `status`
  (7-state enum `:115-118`), `attempts`, `processed_rows`. The **reaper** reads `attempts` +
  `completed_at` for lease expiry.
- **`import_job_rows`** — high-volume per-row ledger. Reuse: `outcome`
  (created|matched|duplicate|skipped|rejected|unprocessed, `:151-154`), `reject_reason`, the four
  audit-pointer `*_contact_id`/`source_import_id` columns, denormalized `workspace_id` for direct RLS.

### 8.2 New columns (the next sequential migration, 0035+)

Two small additions; **no new table** (dim 19 calls for a job-level file hash for exact-file dedup,
and a chunk lease for the reaper). This migration is **not** a reserved fixed filename — several
docs add migrations in the same phase, so it is assigned the next free number (0035, 0036, …) at
implementation time:

```sql
-- the next sequential import-hardening migration (0035+), numbered at implementation
ALTER TABLE import_jobs
  ADD COLUMN file_content_hash bytea,        -- whole-file SHA-256 for exact re-upload detection (Gate C)
  ADD COLUMN canceled_by_user_id uuid,       -- staff actor on an operator cancel (audit pointer, no FK)
  ADD COLUMN paused_at timestamptz;          -- last pause transition (operator transitions, §5.1)

-- Detect an identical file re-uploaded WITHOUT an idempotency key (within a workspace).
CREATE INDEX idx_import_jobs_ws_filehash
  ON import_jobs (workspace_id, file_content_hash)
  WHERE file_content_hash IS NOT NULL;

ALTER TABLE import_job_chunks
  ADD COLUMN lease_expires_at timestamptz,   -- reaper: a running chunk past this is re-enqueued/failed
  ADD COLUMN last_error text;                -- the failure reason surfaced in the chunk drill-down
```

> **Ownership note.** The `import_job_chunks` chunk-lease columns (`lease_expires_at`, `last_error`)
> and the existing `import_job_chunks.attempts` column are **owned here** (doc 05).
> [`13-Performance-and-Scaling`](./13-Performance-and-Scaling.md) **references** them rather than
> re-`ALTER`ing or redefining them (and reuses the existing `attempts` column — it does not add an
> `attempt_count`).

### 8.3 The runtime staging table (unchanged; not a migration)

`stg_import_<jobId>` is created/dropped per job on the owner connection
(`importStagingRepository.ts:189-224, 301-304`) — **never** in a migration. `UNLOGGED`, non-RLS,
uuid-validated name. Columns mirror `StagingRow` (`importStagingRepository.ts:37-60`).

### 8.4 RLS posture & tx wrappers (the load-bearing correctness statement)

| Step | Connection / role | Wrapper | Isolation |
|---|---|---|---|
| Create job, validate list, read job, write counters | `leadwolf_app` (non-BYPASSRLS) | `withTenantTx` (`client.ts:74`) | **RLS-enforced** on `workspace_id` GUC. |
| `COPY` load + staging read/dedup/drop | owner (BYPASSRLS) | `ownerClient` (`client.ts:27`) | **Access-path**: explicit `workspace_id` predicate, uuid-validated table name, encrypted PII. |
| Promote staging → `contacts` | `leadwolf_app` | `withTenantTx` | **RLS-enforced** + ownership-checked. |
| **Operator transitions** (admin, cross-tenant) | owner | **`withPlatformTx`** (`client.ts:121`) | **Audited** — writes `platform_audit_log` in the same tx; only behind verified `pa` claim. |

A staff operator pausing/cancelling another tenant's job is a cross-tenant write — it **must** go
through `withPlatformTx` so a `platform_audit_log` row is written atomically (Platform owns the
tenancy mechanism; Security has final say; no unaudited cross-tenant write).

---

## 9. API Requirements

### 9.1 Customer (Surface 2) — existing, reused

- `POST /api/v1/imports/bulk` — multipart upload+mapping; 202 + `{jobId, status:"queued"}`;
  `Idempotency-Key` header; gates: `authn` + `tenancy` + `rateLimit` + env kill-switch + per-tenant
  `bulk_import_enabled` flag (`bulkRoutes.ts:132-228`). Errors: `ImportValidationError` (422),
  `ForbiddenError` `bulk_import_disabled`/`no_workspace` (403), `NotFoundError` (foreign list).
- `GET /api/v1/imports/bulk/:jobId` — poll; `{jobId, sourceName, status, progress, counts,
  rejectedRowsUrl, createdAt, startedAt, completedAt, failedReason}` (`bulkRoutes.ts:231-268`).

### 9.2 Staff (Surface 1) — new `/api/v1/admin/data/imports/*`

Mounted under `apps/api/src/features/admin/` (the `/admin/data/*` router). All gates:
`authn` (Bearer) → `platformAdmin` (`pa===true`) → `requireStaffRole` (active role per-request) →
`requireCapability(...)`. Pagination = **keyset** (`packages/types/src/search.ts`: `cursor?`,
`limit 1..200 default 50` → `nextCursor`). Writes carry `Idempotency-Key` and a mandatory
`reason`.

| Method · Path | Capability | Tx | Request (Zod) | Response | Errors |
|---|---|---|---|---|---|
| `GET /admin/data/imports` | `data:read` | `withPlatformTx` (read) | query `{cursor?, limit?, status?, tenantId?, source?}` | `{jobs: AdminImportJob[], nextCursor}` | — |
| `GET /admin/data/imports/:jobId` | `data:read` | `withPlatformTx` | path `{jobId}` | `AdminImportJob` (incl. counts, chunk tally) | `NotFoundError` 404 |
| `GET /admin/data/imports/:jobId/chunks` | `data:read` | `withPlatformTx` | `{jobId}` + `{cursor?, limit?}` | `{chunks: AdminImportChunk[], nextCursor}` | 404 |
| `GET /admin/data/imports/:jobId/rows` | `data:read` | `withPlatformTx` | `{jobId}` + `{cursor?, limit?, outcome?}` | `{rows: AdminImportRow[], nextCursor}` (no PII — input redacted) | 404 |
| `GET /admin/data/imports/:jobId/rejected` | `data:read` | `withPlatformTx` | `{jobId}` | `{url}` (signed, expiring) | 404 |
| `POST /admin/data/imports/:jobId/pause` | `data:manage` | `withPlatformTx` | body `{reason: string.min(8)}` + `Idempotency-Key` | `AdminImportJob` (status `paused`) | `ForbiddenError` 403, `ConflictError`/422 if terminal |
| `POST /admin/data/imports/:jobId/resume` | `data:manage` | `withPlatformTx` | `{reason}` + key | `AdminImportJob` (re-enqueued) | 403, 422 if not `paused` |
| `POST /admin/data/imports/:jobId/cancel` | `data:manage` | `withPlatformTx` | `{reason}` + key | `AdminImportJob` (status `cancelled`) | 403, 422 if terminal |
| `POST /admin/data/imports/:jobId/chunks/:chunkId/retry` | `data:manage` | `withPlatformTx` | `{reason}` + key | `AdminImportChunk` (re-enqueued) | 403, 404, 422 if chunk not `failed`/`partial` |

**Idempotency:** the write transitions take an `Idempotency-Key` (middleware/idempotency.ts) so a
double-click pauses once; the transition itself is also naturally idempotent (pause-on-paused = 200
no-op). **Audit action vocabulary (new):** `data.import.paused`, `data.import.resumed`,
`data.import.cancelled`, `data.import.chunk_retried` — written by `withPlatformTx` with
`{targetType:"import_job", targetId:jobId, tenantId, workspaceId, metadata:{reason, chunkId?}}`.

**New staff capabilities** (`packages/types/src/staffCapability.ts:13` — extend the closed enum):
`data:read`, `data:manage`, `data:review`, `data:export` (per
[`11-Roles-and-Permissions`](./11-Roles-and-Permissions.md)). `data:read`/`data:manage` are the two
this doc needs; bundle into `ROLE_CAPABILITIES` (e.g. a future `data_ops` role; `super_admin` implies
all). High-risk transitions (cancel on a >100k-row running job) additionally require **JIT
elevation** (`jit_elevations`) per the maker/checker policy in
[`09-Review-and-Approval-System`](./09-Review-and-Approval-System.md).

---

## 10. Edge Cases & Failure Scenarios

| # | Scenario | Handling |
|---|---|---|
| E1 | **Header-only file** (zero data rows) | `planBands` returns `[]`; `runBulkImport` finalizes inline (`completed`/`partial`) and drops staging (`runBulkImport.ts:159-169`). No chunk ever fires finalize. |
| E2 | **Re-submit with same Idempotency-Key** | `(workspace_id, idempotency_key)` ws-unique collapses onto the existing job; `created:false` ⇒ no re-upload, no duplicate drive (`bulkRoutes.ts:186, 206`). Poll reflects the original. |
| E3 | **Identical file, no idempotency key** | `file_content_hash` index (§8.2) flags it; wizard offers "identical to job X" rather than double-load. |
| E4 | **Object-store write fails mid-upload** | Job marked `failed` with `failedReason`, best-effort, then the error surfaces (`bulkRoutes.ts:209-220`). |
| E5 | **Worker crashes mid-`running`** | `UNLOGGED` staging may be lost; the object-store file is the source of truth → DRIVE re-stages on re-drive, OR (if staging survived) resume re-enqueues only non-`completed` chunks (`runBulkImport.ts:94-110`). The **reaper** re-enqueues lease-expired chunks. |
| E6 | **`COPY` partially loaded then fails** | Stage is **re-runnable**: re-drive truncates/recreates staging (`IF NOT EXISTS` + dedup is idempotent) — never double-loads because resume only fires when `stagingTable` set AND chunks exist. |
| E7 | **AV scan returns `infected`** | Refused before any job exists (sync route) or job flipped `failed` (worker re-check); file never promoted (`bulkRoutes.ts:170-171`). |
| E8 | **Foreign / absent `target_list_id`** | 404 at submit (`assertListInWorkspace`, `bulkRoutes.ts:166`) AND re-validated under RLS in the worker (`runBulkImport.ts:113-118`) — the client list id is never trusted. |
| E9 | **Operator cancels a `running` job** | `cancelled`; fan-out stops; staging dropped; **already-promoted contacts are kept** (non-destructive — promote is committed per-chunk). Counters reflect partial landing. |
| E10 | **Operator pauses, then the worker finishes the in-flight chunk** | The in-flight chunk completes and increments; new chunks aren't claimed while `paused`; resume re-enqueues the rest. No row processed twice (chunk-level idempotency on `(job, chunk)` unique, `importJobs.ts:114`). |
| E11 | **Retry a chunk that actually succeeded** | Chunk `completed` ⇒ retry is a 422 (`chunk not retryable`); the per-row ledger prevents re-promoting (matched rows are idempotent on dedup keys). |
| E12 | **`within-file` duplicates** | `dedupWithinFile` keeps the lowest `source_row_num` survivor per `identity_key`; non-survivors `dedup_in_file`, counted in `rows_deduped` (`importStagingRepository.ts:251-264`). |
| E13 | **Rejected-rows artifact write fails** | Best-effort; never fails the import (`runBulkImport.ts:132-141`). The job still completes; `rejectedRowsUrl` is null. |
| E14 | **Staging table name collision** (re-drive) | `CREATE … IF NOT EXISTS` + idempotent dedup; uuid-derived name is unique per job (`importStagingRepository.ts:189`). |
| E15 | **Eventual consistency** (dim 1) | Poll/`get-job-info` surfaces `processed (completed_chunks/total)` vs `available`; the UI shows "~30s to reflect" copy; webhook fires only on terminal. |

---

## 11. Testing Strategy

- **Unit (`@leadwolf/core`):** `bulkStage` counters + within-file dedup precedence
  (email→linkedin→sales-nav); `planBands` boundaries (0, exact multiple, +1); `csvField` encoding
  (bytea `\x` hex, NULL empty, quote-doubling) — extend `dedupHelpers.test.ts`, add
  `bulkStage.test.ts`, `runBulkImport.test.ts` (collector-injected `enqueueChunk`).
- **Integration (`apps/api`, real PG):** the **`copyRows` Gate-A spike promoted to a test** — load
  via `COPY FROM STDIN`, read back, assert byte-for-byte bytea round-trip; the
  `(workspace_id, idempotency_key)` replay (second POST returns the same jobId, no second drive); the
  operator transitions (pause→resume→cancel state guards + 422s on illegal transitions); each write
  asserts a `platform_audit_log` row exists in-tx.
- **itest (worker):** end-to-end DRIVE → chunk → finalize on a seeded 25k-row CSV; assert terminal
  status, counter reconciliation (`created+matched+duplicate+skipped+rejected+deduped+unprocessed =
  total`), staging dropped, rollups fired once. Test-batch first (dim 8/23): a 25–50 row smoke run.
- **Mandatory tenant-isolation test** (a write path): seed jobs in ws-A and ws-B; assert (1)
  `readChunkBand(ws-A)` never returns a ws-B staging row (drop the predicate in a fixture → test must
  fail), (2) a Surface-2 caller in ws-B gets 404 on ws-A's `GET /imports/bulk/:jobId`
  (`bulkRoutes.ts:242`), (3) a staff cancel on ws-A writes a `platform_audit_log` row naming
  `tenantId`/`workspaceId` of ws-A. This is the non-negotiable isolation test for the staging
  bypass.

---

## 12. Rollout & Migration Plan

1. **The next sequential migration (0035+)** (additive columns/indexes §8.2) ships first —
   backward-compatible, no backfill (new columns nullable). The number is assigned at implementation
   (not a reserved `0035_import_hardening.sql`), since other docs add migrations in the same phase.
2. **Gate A green** (COPY spike) — recorded in an ADR addendum; until then `BULK_IMPORT_ENABLED`
   stays false and the worker consumer isn't registered.
3. **Gate B** prod `FileStore` deployed + smoke-tested (presigned multipart, AV, signed download).
4. **Shadow:** `BULK_IMPORT_ENABLED=true` in a non-prod env; per-tenant flag off everywhere. The
   admin drill-down (`data:read`) ships read-only — operators observe sync imports.
5. **Canary:** enable `bulk_import_enabled` for 1–2 internal/design-partner workspaces; watch
   reaper, counter reconciliation, COPY throughput, object-store cost.
6. **GA:** progressively enable per-tenant. Operator transitions (`data:manage`) enabled for the
   `data_ops`/`super_admin` roles. High-risk cancel gated behind JIT elevation + maker/checker
   ([`09`](./09-Review-and-Approval-System.md)).
7. **Backfill:** none required — `import_jobs` is forward-only; historical sync imports remain in
   their own table/path. The sync→bulk promotion threshold (`BULK_IMPORT_THRESHOLD_ROWS`) is tuned
   once real throughput is measured.

Rollback at any stage = flip `BULK_IMPORT_ENABLED=false` (global kill-switch, `bulkRoutes.ts:53-58`)
or the per-tenant flag — the api then creates/enqueues nothing and the feature is inert.

---

## 13. Success Metrics & Acceptance Criteria

**Metrics:** COPY load throughput (rows/s); chunk p95 promote latency; counter-reconciliation error
rate (must be 0); rejected-row rate per source; reaper re-enqueue count; object-store spend/import;
operator-transition MTTR (time from stuck-job alert to resume/cancel).

**Acceptance criteria (testable checklist):**

- [ ] **AC1** — Gate-A spike proves `copyRows` (Writable + byte-for-byte CSV round-trip + bytea→Buffer)
      on real Postgres; result recorded in an ADR.
- [ ] **AC2** — A prod `FileStore` adapter implements all four port methods with presigned multipart,
      AV-before-promote, and signed+expiring downloads; `diskFileStore` is never selected when
      `NODE_ENV=production`.
- [ ] **AC3** — A re-submitted `Idempotency-Key` returns the same `jobId` and triggers no second
      upload or drive (integration test green).
- [ ] **AC4** — An identical file with no idempotency key is detected via `file_content_hash` and
      surfaced, not double-loaded.
- [ ] **AC5** — The full state machine is reachable and illegal transitions 422
      (cancel-on-completed, resume-on-running, retry-on-completed-chunk).
- [ ] **AC6** — Every operator transition writes exactly one `platform_audit_log` row in the same tx,
      naming actor + `tenantId`/`workspaceId` + `reason`.
- [ ] **AC7** — The mandatory tenant-isolation test passes: no cross-workspace staging read, 404 on a
      foreign job poll, audited cross-tenant cancel.
- [ ] **AC8** — A 25k-row itest reconciles counters exactly and fires the dedup/firmographics/
      masterBackfill rollups once on terminal.
- [ ] **AC9** — The reaper re-enqueues a lease-expired `running` chunk and never double-promotes a
      row (chunk-level idempotency).
- [ ] **AC10** — Both surfaces render all four states (loading/empty/error/data) via `StateSwitch`;
      the admin operator actions require a non-empty justification reason.
- [ ] **AC11** — A header-only file and an all-rejected file both reach a correct terminal status
      (`completed`/`partial`) without a wedged job.
- [ ] **AC12** — With `BULK_IMPORT_ENABLED=false` every bulk route 403s and the worker consumer is
      not registered (the Dark posture is verifiable in prod).

---

### Cross-references

[`01-Current-State-Analysis`](./01-Current-State-Analysis.md) ·
[`02-Enterprise-Research`](./02-Enterprise-Research.md) ·
[`03-Gap-Analysis`](./03-Gap-Analysis.md) ·
[`04-Control-Panel-Architecture`](./04-Control-Panel-Architecture.md) ·
[`06-Data-Validation-Framework`](./06-Data-Validation-Framework.md) ·
[`07-Deduplication-and-Linking`](./07-Deduplication-and-Linking.md) ·
[`08-Data-Enrichment-Workflow`](./08-Data-Enrichment-Workflow.md) ·
[`09-Review-and-Approval-System`](./09-Review-and-Approval-System.md) ·
[`10-Monitoring-and-Observability`](./10-Monitoring-and-Observability.md) ·
[`11-Roles-and-Permissions`](./11-Roles-and-Permissions.md) ·
[`12-Security-and-Compliance`](./12-Security-and-Compliance.md) ·
[`13-Performance-and-Scaling`](./13-Performance-and-Scaling.md) ·
[`14-Implementation-Roadmap`](./14-Implementation-Roadmap.md) ·
[`15-Future-Enhancements`](./15-Future-Enhancements.md) ·
[`README`](./README.md)
