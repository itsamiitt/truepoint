# 01 — Current-State Audit (code-grounded source of truth)

> **Status of this doc:** complete (re-verified against the repo at commit `13b6ad1`,
> branch `feat/data-mgmt-01-research-brief`, 2026-07-02).
> **Rule:** every claim below carries a `file:line` citation that was opened and read during this
> audit — not inherited from a prior doc. Where a prior brief's citation had drifted, the corrected
> line is used and the drift is noted. Status badges follow the series legend
> (✅ shipped & live · 🌒 built, dark · 💤 built, inert/double-gated · 🟡 partial · 🔲 not built ·
> ❌ blocked on a missing prerequisite).

---

## 1. Reading guide — how this doc relates to prior audits

This is the current-state baseline every other doc in this series cites. It **does not duplicate**
the four prior audits; it supersedes them only where the code has moved since they were written:

| Prior audit | What it covers | What this doc adds / supersedes |
|---|---|---|
| [`../data-management/14-implementation-log.md`](../data-management/14-implementation-log.md) | Running log of what the data-management backlog (#1–#13) shipped | This doc re-verifies the import-relevant entries (#2 bulk import, #6 retention) at head |
| [`../database-management-research/01-Current-State-Analysis.md`](../database-management-research/01-Current-State-Analysis.md) | Staff-console (Surface 1) current state | This doc is the Surface-2 (customer `apps/web`) counterpart; staff surfaces appear here only as the correctly-locked contrast (§5.6) |
| [`../database-management-research/16-Implementation-Audit.md`](../database-management-research/16-Implementation-Audit.md) | Living shipped-record for the db-mgmt series | §8's ledger mirrors its format; where both name the same artifact, trust whichever has the later verified-at commit |
| [`../prospect-database-platform/02-Current-State-Deep-Audit.md`](../prospect-database-platform/02-Current-State-Deep-Audit.md) | Layer-0 master graph / ER / enrichment deep audit | §6 here compresses the overlay↔master boundary to what the import redesign needs; go there for ER internals |
| [`../worker-platform/01-current-architecture-audit.md`](../worker-platform/01-current-architecture-audit.md) | Queue/worker substrate audit | §7.2 here records only the deltas that shipped after it (deadlines, tuning, outbox, metrics) |

Root causes are **not** argued here — that is `02-Root-Cause-and-Gap-Analysis.md`. This doc states
what exists, where, and in what state.

---

## 2. The two import systems

The single most important framing fact: **TruePoint has two separate import-job systems** that
share the parse/validate/prepare primitives but nothing else — different transport, different job
state, different durability, different visibility surface.

| Dimension | Sync CSV/XLSX import ✅ LIVE | Bulk COPY-staging import 🌒 DARK |
|---|---|---|
| Entry | `POST /api/v1/imports` (`apps/api/src/app.ts:112`) | `POST /api/v1/imports/bulk` (`apps/api/src/app.ts:111`, mounted *before* the sync router so `/bulk` is never captured as a `:jobId` — `app.ts:109–111`) |
| Gate | none (any workspace member) | double-gated: `env.BULK_IMPORT_ENABLED` **and** per-tenant `bulk_import_enabled` flag (§2.2) |
| File handling | parsed **on the request thread** (`routes.ts:152`) | raw bytes streamed to a FileStore; parsed in the worker (`bulkRoutes.ts:209–210`) |
| Queue | BullMQ `imports` | BullMQ `bulk-imports` (drive → chunk fan-out) |
| Job state | **Redis only** — BullMQ job + progress; `removeOnComplete: { age: 24h, count: 1000 }` (`queue.ts:31`) | durable Postgres control trio `import_jobs` / `import_job_chunks` / `import_job_rows` (`packages/db/src/schema/importJobs.ts`) |
| Durable record | only per-row provenance (`source_imports`), no job row | full 9-state job row + per-row ledger |
| List endpoint | **none** (router exposes only `POST /`, `POST /preview`, `GET /:jobId` — `routes.ts:115,127,168`) | none for tenants (a repo method exists, unrouted — §5.2); staff-only cross-tenant list exists (§5.6) |
| Progress UI | wizard inline poll, 1.5 s × 80 ≈ 2 min then gives up (`useImport.ts:30–31,79–83`) | dedicated page `/imports/[jobId]`, 3 s poll until terminal (`useBulkImport.ts:14,21`) |

### 2.1 End-to-end trace — sync path ✅ LIVE

| # | Hop | Where (verified) | What happens |
|---|---|---|---|
| 1 | Route mount | `apps/api/src/app.ts:112` | `app.route("/api/v1/imports", importRoutes)`; mapping-templates and `/bulk` prefixes registered first (`app.ts:107–111`) |
| 2 | Middleware | `apps/api/src/features/import/routes.ts:41–43` | `authn` → `tenancy` → `rateLimit`; workspace comes from the verified token, never the body |
| 3 | Preview (optional) | `routes.ts:115–125` | `POST /preview` parses + validates and returns counts/samples with **no** enqueue, no DB writes |
| 4 | Submit | `routes.ts:127–165` | multipart parse; explicit `conflictPolicy` (default `skip`, `routes.ts:139–144`); optional `listId` validated against the verified workspace **before** enqueue (`routes.ts:149–150`); whole file parsed on-thread (`routes.ts:152`); `202` + `{jobId, status:"queued"}` (`routes.ts:163–164`) |
| 5 | Enqueue | `apps/api/src/features/import/queue.ts:46–51` | rows travel **in the job payload**; backpressure sheds with a typed 503 above 10 000 waiting (`queue.ts:41,48`); `attempts: 3`, exponential backoff 2 s + jitter 0.5 (`queue.ts:28–29`); terminal retention `removeOnComplete: { age: 24*3600, count: 1000 }`, `removeOnFail: false` (`queue.ts:31–32`) |
| 6 | Worker | `apps/workers/src/register.ts:586–588` | `processImport` wrapped in `withDeadline` + per-queue tuning |
| 7 | Process | `apps/workers/src/queues/imports.ts:33–68` | coarse progress via `job.updateProgress`; runs the **same** `runImport`; a zero-progress import throws `ImportFailedError` so BullMQ retries then dead-letters (`imports.ts:63–66`) |
| 8 | Pipeline | `packages/core/src/import/runImport.ts:1–7` | per row, in one `withTenantTx`: map → normalize → blind index + content hash → encrypt PII → idempotency check → account upsert by domain → dedup match (email → linkedin → sales-nav) → insert/update → **exactly one `source_imports` provenance row** → optional `list_members` add. One bad row never rolls back the import |
| 9 | DLQ | `imports.ts:75–95` | exhausted jobs dead-letter as a **PII-free** record (scope + provenance + reason, never rows) |
| 10 | Status poll | `routes.ts:168–189` | `GET /:jobId` reads the BullMQ job; foreign-workspace or unknown id → 404 (`routes.ts:173–176`); BullMQ state mapped to the public enum (`routes.ts:46–62`) |
| 11 | UI | `apps/web/src/app/import/page.tsx` → `apps/web/src/features/import/components/ImportWizard.tsx`; poll loop `apps/web/src/features/import/hooks/useImport.ts:30–31` | 1.5 s cadence, 80 attempts, 3-consecutive-error tolerance (`useImport.ts:34`); on attempt 81: *“Import is taking longer than expected. Check back shortly.”* (`useImport.ts:79–83`) |

The happy path is functionally sound: middleware, list-id trust boundary, idempotent per-row
transactions, RFC 9457 errors, backpressure and DLQ are all in place. What it lacks is **any
durable, listable job record** — the moment Redis evicts the job (24 h, or the 1 000-job count
cap) the only trace an import ever ran is its `source_imports` rows.

### 2.2 End-to-end trace — bulk COPY path 🌒 DARK (double-gated)

| # | Hop | Where (verified) | What happens |
|---|---|---|---|
| 1 | Gate layer 1 (env) | `apps/api/src/features/import/bulkRoutes.ts:53–58`; `packages/config/src/env.ts:227–230` | `BULK_IMPORT_ENABLED` is false unless the string is exactly `"true"`; while off, **every** bulk route (POST and GET) 403s with RFC-9457 `bulk_import_disabled` before any work |
| 2 | Gate layer 2 (tenant flag) | `bulkRoutes.ts:145–149` | on POST only, `isFlagEnabledForTenant(tx, tenantId, BULK_IMPORT_FLAG_KEY)` under the tenant tx — fail-closed (`packages/core/src/featureFlags/flagsForTenant.ts:56–62`); the flag row is seeded off in the rollout-flags seed migration¹ |
| 3 | AV seam | `bulkRoutes.ts:126–128, 168–171` | `scanUpload()` returns `"skipped"` — no scanner wired (§3.3); an `"infected"` result would refuse before any job exists |
| 4 | Control row first | `bulkRoutes.ts:186–204` | `importJobRepository.createJob` in a short tx; `Idempotency-Key` collapses re-submits onto the existing job via the partial unique `(workspace_id, idempotency_key)` (`bulkRoutes.ts:181`, `schema/importJobs.ts:80–82`) |
| 5 | Stream upload | `bulkRoutes.ts:206–220` | only for a freshly created job: `bulkFileStore().putObject(sourceKey, file.stream())` — constant memory; storage failure marks the job `failed`; then **one** `drive` job is enqueued |
| 6 | Worker gate | `apps/workers/src/register.ts:848` | `if (env.BULK_IMPORT_ENABLED)` — while off, the bulk queues/worker are **never constructed**; `concurrency: 1` while dark (`register.ts:888`) |
| 7 | Drive | `apps/workers/src/queues/bulkImports.ts:78–93` → `packages/core/src/import/runBulkImport.ts` | stage then plan + fan out one `chunk` job per ~10 000-row band (`runBulkImport.ts:23`); watermark-resumable (a re-drive never re-stages) |
| 8 | Stage | `packages/core/src/import/bulkStage.ts:1–10` | streams the file from the FileStore in constant memory; **reuses `validateRow` + `prepareContact` verbatim** (bulk-vs-sync parity); COPY-loads prepared (already-encrypted) rows into a per-job UNLOGGED staging table; within-file dedup in SQL; rejected rows recorded for the artifact, never staged |
| 9 | Chunk | `bulkImports.ts:95–99` → `packages/core/src/import/bulkProcessChunk.ts` | merges one staged band into the overlay |
| 10 | Finalize | `bulkImports.ts:104–111` | only a real completion increments `completed_chunks`; the last chunk's finalize fires the dedup/firmographics/masterBackfill rollups **once**, best-effort, directly (not via the outbox — §7.1) (`register.ts:865–884`) |
| 11 | DLQ | `bulkImports.ts:131–139` | PII-free dead-letter, mirroring the sync path |
| 12 | Status poll | `bulkRoutes.ts:231–268` | `GET /imports/bulk/:jobId` under RLS; progress = `completedChunks/totalChunks` (`bulkRoutes.ts:247`); when terminal with rejects, a signed URL for the `rejected-rows.csv` artifact (`bulkRoutes.ts:250–253`) |
| 13 | UI | `ImportWizard.tsx:228–246` → `router.push(\`/imports/${ref.jobId}\`)` (`ImportWizard.tsx:241`); `apps/web/src/app/(shell)/imports/[jobId]/page.tsx`; poll `useBulkImport.ts:14,21` | 3 s cadence until `completed | partial | failed | cancelled`; `paused` keeps polling; a 403 renders a distinct `disabled` state, not an error |

**The durable trio** (`packages/db/src/schema/importJobs.ts`):

- `import_jobs` — one control row per upload; 9-state machine enforced by CHECK:
  `queued, validating, staged, running, paused, completed, partial, failed, cancelled`
  (`importJobs.ts:83–86`); AV status `pending|clean|infected|skipped` (`importJobs.ts:87–90`);
  full row accounting (`rows_total/created/matched/duplicate/skipped/rejected/deduped/unprocessed`,
  `importJobs.ts:59–66`); non-PII `reject_histogram` + rejected-artifact key (`importJobs.ts:67–70`);
  resume watermark `byte_offset` (`importJobs.ts:56`).
- `import_job_chunks` — claimable row bands, unique `(job_id, chunk_index)` (`importJobs.ts:99–123`).
- `import_job_rows` — per-input-line ledger with outcome enum and audit-pointer uuids (no FKs)
  (`importJobs.ts:129–159`); **partitioning intent documented, not built** (`importJobs.ts:6–9,125–128`).

One naming trap, verified: `import_jobs.source_name`'s inline comment says “original filename shown
to the user” (`importJobs.ts:47`) but the API actually writes the `SourceName` **provider enum**
there (byte-identical to the sync path's provenance stamp); the filename travels only inside the
object key (`bulkRoutes.ts:191–197`).

### 2.3 Where the two systems touch

- Shared primitives: `parseImportFile` / `validateRow` / `prepareContact` / `contentHash` /
  conflict-policy semantics (`bulkStage.ts:2–5`, `bulkRoutes.ts:75–77`).
- Shared trust boundary: workspace from the verified token, client `listId` validated pre-enqueue
  (`routes.ts:149–150`, `bulkRoutes.ts:165–166`).
- Shared rollups: the same idempotent dedup/firmographics/masterBackfill jobs fire on completion of
  either path (`register.ts:846–847`).
- **Not** shared: job identity (BullMQ id vs `import_jobs.id`), status vocabulary, progress
  contract, retention, visibility surface.

---

## 3. The three unmet bulk enable-gates ❌

The bulk path is code-complete but its rollout is blocked on three prerequisites, all confirmed
still open at head:

### 3.1 Production object store ❌

`apps/api/src/features/import/bulkStore.ts:16–19` — the single composition point constructs
`diskFileStore(env.BULK_IMPORT_STORAGE_DIR)` unconditionally; the header (`bulkStore.ts:1–7`)
states the production S3 adapter (presigned multipart + AV-before-promote) “is injected HERE later
(no AWS SDK is pulled into the repo yet)”. The worker composes its **own** disk store against the
same env dir (`register.ts:853–855`). On any multi-instance deployment where API and worker do not
share a filesystem, the producer's write and the consumer's read land on different disks — the
local-disk adapter is dev/test-only by design (`env.ts:231–234`).

### 3.2 COPY-FROM-STDIN spike unproven ❌

`packages/db/src/repositories/importStagingRepository.ts:10–17` carries a boxed **UNVERIFIED**
banner: the `copyRows` streaming path is the one load-bearing primitive that cannot be exercised in
the sandbox; `postgres.js` has zero prior `COPY`/`.writable()` usage in the repo; before
`BULK_IMPORT_ENABLED` is turned on, the spike must prove (1) `unsafe(<COPY … FROM STDIN>).writable()`
returns a backpressure-aware Writable, (2) the CSV encoding (bytea as unquoted `\x<hex>`, unquoted
empty = NULL, quoted text/json) round-trips byte-for-byte, (3) bytea reads back as Buffer. The
staging table is deliberately **non-RLS on the owner connection** (Postgres forbids COPY on RLS
tables); isolation is by access path — every read carries an explicit `workspace_id` predicate,
confined to this one repository (`importStagingRepository.ts:1–8`).

### 3.3 AV scan stub ❌

`bulkRoutes.ts:121–128` — `scanUpload()` is a seam returning `"skipped"`; the refusal logic for
`"infected"` exists (`bulkRoutes.ts:169–171`) and the status column and enum are in place
(`importJobs.ts:50,87–90`), but no scanner is wired at the composition root. Every upload is
recorded `av_scan_status = 'skipped'`.

> The roadmap (doc `14`) assumes these three gates get cleared in their phase (confirmed program
> decision #2 in the series README); doc `16` tracks their live state.

---

## 4. Perceived-breakage inventory

Why users report “imports are broken” even though the sync happy path works. Each item is a
verified behavior, not a hypothesis (causal ranking lives in doc `02`).

### 4.1 The “Large file” toggle is a visible dead end 🟡

The wizard renders the toggle unconditionally:
`apps/web/src/features/import/components/ImportWizard.tsx:305–313` —
`label="Large file — import in the background (recommended for big uploads)"`. With the feature
dark (which is every environment today), submitting hits the layer-1 403 and the user gets:
*“Bulk import isn’t enabled for your workspace yet. Switch off ‘Large file’ to import now, or
contact your …”* (`ImportWizard.tsx:427–432`). The UI **recommends** a path that is guaranteed to
fail, then tells the user to undo their choice.

Related verified fact (new in this audit, not in prior briefs): `BULK_IMPORT_THRESHOLD_ROWS`
(default 5000) is defined at `packages/config/src/env.ts:235–237` with a comment saying it is
“consumed by the promotion logic” — **no code consumes it** (repo-wide grep finds only the env
definition and planning docs). There is no server-side sync→bulk promotion; routing is a manual
client checkbox.

### 4.2 Poll abandonment ✅ (behavior confirmed)

`useImport.ts:30–31` — 1 500 ms × 80 attempts ≈ 2 minutes, then the wizard surfaces *“Import is
taking longer than expected. Check back shortly.”* (`useImport.ts:79–83`) — but there is nowhere to
“check back”: no imports list exists (§2 table), and navigating away destroys the only handle on
the job (the in-memory `jobId`). A large-but-legal CSV that takes 3 minutes looks identical to a
dead one.

### 4.3 Job state evaporates from Redis ✅ (behavior confirmed)

`queue.ts:31` — completed jobs are kept 24 h **or** until 1 000 newer terminal jobs exist,
whichever trims first. After eviction, `GET /imports/:jobId` returns 404 (“Import job not found”,
`routes.ts:173–176`) — indistinguishable from a job that never existed.

### 4.4 Recent Imports card shows the whole workspace's imports ✅ (behavior confirmed)

`apps/web/src/features/home/components/RecentImportsCard.tsx:12–50` renders
`HomeSummary.recentImports`, which comes from `GET /home/summary`
(`apps/api/src/features/home/routes.ts:55`) → `buildHomeSummary`
(`packages/core/src/home/buildHomeSummary.ts:51`) →
`sourceImportRepository.recentBatches` (`packages/db/src/repositories/sourceImportRepository.ts:105–129`):
grouped provenance rows, **workspace-scoped via RLS only** — no per-user filter, although
`source_imports.imported_by_user_id` exists (`packages/db/src/schema/contacts.ts:252`). Every
member's home page shows every other member's uploads. This is one instance of the §5 pattern.

---

## 5. Job-visibility surface inventory

The confirmed defect class: **job visibility everywhere is workspace-scoped only** — no owner
predicate, no capability gate beyond workspace membership. The creator columns exist and are
populated; nothing reads them for scoping. Exact predicates, quoted:

### 5.1 RLS on the durable import trio 🌒

`packages/db/src/rls/importJobs.sql:11–13`:

```sql
CREATE POLICY import_jobs_workspace_isolation ON import_jobs
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
```

Same shape for `import_job_rows` (`importJobs.sql:15–20`); chunks scope through the parent job
(`importJobs.sql:23–34`). Fail-closed on unset GUCs — correct as a **tenant** wall. There is no
user GUC anywhere in the RLS layer: `withTenantTx` sets only `app.current_tenant_id` and
`app.current_workspace_id` (`packages/db/src/client.ts:82–91`), so RLS *cannot* express
“owner or admin” today — any owner predicate must live in the app layer.

### 5.2 `importJobRepository.listJobsByWorkspace` — dead code, no owner filter 🌒

`packages/db/src/repositories/importJobRepository.ts:170–176`: `select().from(importJobs)
.orderBy(desc(createdAt), desc(id)).limit(capped)` — RLS-workspace-scoped, **no
`created_by_user_id` predicate**. Repo-wide grep: its only callers are the package's own
integration tests (`packages/db/test/importJobs.itest.ts:75,90,109`) — **no tenant-facing route is
wired to it**. The column it would need exists: `schema/importJobs.ts:45`
(`created_by_user_id`, null = system/automation) and is populated on create
(`bulkRoutes.ts:190`).

### 5.3 Reveal jobs — live and leaking the same way ✅

`apps/api/src/features/reveal/routes.ts:201–208`:
`GET /reveal-jobs` behind `requireRole("owner", "admin", "member", "viewer")` →
`revealJobRepository.listJobsByWorkspace` (`packages/db/src/repositories/revealJobRepository.ts:168–176`)
— workspace-only, newest-first, no owner filter. Any viewer sees every member's reveal jobs.

### 5.4 Enrichment jobs — live and leaking the same way ✅

`apps/api/src/features/enrichment/routes.ts:47–56`: `GET /jobs` behind the same four-role
`requireRole` → `listEnrichmentJobs` (`packages/core/src/enrichment/jobStatus.ts:78–84`) →
`enrichmentJobRepository.listJobsByWorkspace`
(`packages/db/src/repositories/enrichmentJobRepository.ts:229–233`) — workspace-only.

### 5.5 Recent Imports card ✅

§4.4 — `sourceImportRepository.recentBatches` is workspace-only; `imported_by_user_id` unused.

### 5.6 The correctly-locked contrast: staff surfaces ✅

- `GET /admin/import-jobs` (`apps/api/src/features/admin/routes.ts:1159–1168`) — cross-tenant
  bulk-import monitor behind `requireStaffRole("super_admin", "support", "read_only")`, on the
  audited `withPlatformTx`, metadata + tallies only (never `import_job_rows`).
- The data-ops panel reads (`apps/api/src/features/admin/dataRoutes.ts:1–12`) — mounted under
  the platform-admin middleware, granularly gated by `requireCapability("data:read")` per route
  (overview at `dataRoutes.ts:151`, import drill-down at `dataRoutes.ts:209`) against the
  shipped capability enum (`packages/types/src/staffCapability.ts:13–38` — 21 capabilities;
  `data_ops` bundle at `staffCapability.ts:66`).

These are **not** the leak; they demonstrate the target discipline (Surface 1 vs Surface 2, per
the series README's two-surface note).

### 5.7 Summary matrix

| Surface | Route/read | Scoping today | Creator column exists? | Status |
|---|---|---|---|---|
| Sync import job poll | `GET /imports/:jobId` (`routes.ts:168–189`) | workspace check on the Redis job | in payload (`importedByUserId`) | ✅ live; per-job only, no list |
| Bulk import list (repo) | `listJobsByWorkspace` (`importJobRepository.ts:170–176`) | RLS workspace only | yes (`importJobs.ts:45`) | 🌒 unrouted dead code |
| Bulk import poll | `GET /imports/bulk/:jobId` (`bulkRoutes.ts:231–268`) | RLS + explicit workspace check | yes | 🌒 dark |
| Reveal jobs list | `GET /reveal-jobs` (`reveal/routes.ts:201–208`) | workspace only, viewer+ | (see repo) | ✅ live, leaks within workspace |
| Enrichment jobs list | `GET /jobs` (`enrichment/routes.ts:47–56`) | workspace only, viewer+ | (see repo) | ✅ live, leaks within workspace |
| Home Recent Imports | `recentBatches` (`sourceImportRepository.ts:105–129`) | workspace only | yes (`contacts.ts:252`), unused | ✅ live, leaks within workspace |
| Staff import monitor | `GET /admin/import-jobs` (`admin/routes.ts:1159–1168`) | staff role + audited platform tx | n/a | ✅ correctly locked |

---

## 6. Contact/Company data model — as-is

### 6.1 The three-layer model ✅

- **Layer 0 — system-owned master graph** (`packages/db/src/schema/masterGraph.ts:3–4`): seven
  tables — `master_companies`, `master_persons`, `master_employment` (SCD2 stints,
  `masterGraph.ts:149–156`), `master_emails` (`masterGraph.ts:228`), `master_phones`
  (`masterGraph.ts:259`), `source_records`, `match_links`. **No tenancy columns, no RLS** —
  isolation is structural, by access path: only the least-privilege `withErTx` role reaches it
  (`packages/db/src/client.ts:56–61` — `leadwolf_er`, non-BYPASSRLS, no overlay grants).
- **Layer 1 — per-workspace overlay**: `accounts` + `contacts`
  (`packages/db/src/schema/contacts.ts`), RLS workspace isolation
  (`packages/db/src/rls/contacts.sql:17–44`, fail-closed `NULLIF` GUC idiom), reached only via
  `withTenantTx` (`client.ts:74–94`). Nullable bridges `master_person_id` / `master_company_id`
  (`contacts.ts:112`, `contacts.ts:50`) — re-pointable, never cascade-deleted.
- **Lineage**: `source_imports` — one row per landed import row, the only lineage under ADR-0006
  (`contacts.ts:240–276`), workspace-RLS'd (`rls/contacts.sql:38–44`).

### 6.2 Email/phone: single flat encrypted columns; no multi-value anywhere in practice ✅

On `contacts` (`contacts.ts:120–136`): `email_enc` (AES-GCM bytea) + `email_blind_index` (HMAC) +
`email_domain` (clear facet) + `email_status`; `phone_enc` + `phone_status` + `phone_line_type`.
**One email, one phone per contact.** Dedup/uniqueness rides the blind index, since ciphertext
can't be unique-constrained (`contacts.ts:1–4`).

The Layer-0 channel tables (`master_emails` / `master_phones`) are multi-value in *shape*, but —
verified stronger than prior briefs claimed — they hold **no revealable values today**: the only
writer is the co-op-safe import resolve, which stores *only* `email_blind_index` + `email_domain`
with `email_enc = NULL` (`packages/db/src/repositories/masterGraphRepository.ts:15–16,137–138`),
and phone resolution is deferred entirely — `phoneBlindIndex` is accepted for forward-compat but
never read (`masterGraphRepository.ts:27–28`). No application code joins these tables into any
read path (repo-wide grep: the Drizzle identifiers appear only in `masterGraph.ts` itself; raw-SQL
usage only in `masterGraphRepository.ts` and db tests). **There is no multi-phone/multi-email
capability anywhere in the product today** — that is the redesign target of docs `04`/`05`.

### 6.3 Dedup keys ✅

Per-workspace partial uniques (`contacts.ts:187–195`): `(workspace_id, email_blind_index)`,
`(workspace_id, linkedin_public_id)`, `(workspace_id, sales_nav_lead_id)` — each only where the
key is non-null. Accounts: `(workspace_id, domain)` partial unique (`contacts.ts:83–85`). Match
precedence email → linkedin → sales-nav is shared by the sync import, the bulk staging
`identity_key`, and `findByDedupKeys` (`bulkStage.ts:7–10`).

### 6.4 Ownership = filter-only ✅

`contacts.owner_user_id` (`contacts.ts:113–117`) is explicitly documented as a **filter dimension,
never a per-row access wall**: “Visibility stays workspace-wide via RLS.” SET NULL on user delete.
Every workspace member sees every contact; teams are grouping, not an access boundary. RLS
policies isolate on `workspace_id` alone (`rls/contacts.sql:31–33`).

### 6.5 Accounts: single domain, no hierarchy, no locations, no soft delete ✅

The full `accounts` column set (`contacts.ts:42–100`) has: one `domain` (`contacts.ts:52`), **no**
`parent_account_id`, **no** child domain/location tables, **no** `deleted_at` (contrast
`contacts.deleted_at`, `contacts.ts:165`) — account deletion is hard-delete only. Hierarchy and
multi-domain exist **only** at Layer 0: `master_companies.parent_company_id`
(`masterGraph.ts:63`) and `alt_domains[]` (`masterGraph.ts:58`) — not surfaced to the overlay.

### 6.6 No employment history in the overlay ✅

Overlay = flat `contacts.account_id` + denormalized `job_title` (`contacts.ts:109,128`). Stint
history (SCD2 validity, is_current/is_primary) exists only in Layer-0 `master_employment`
(`masterGraph.ts:149–156,170`).

### 6.7 Custom fields ✅

Per-workspace typed registry `custom_field_definitions`
(`packages/db/src/schema/customFields.ts:36`) + `custom_fields` jsonb on both `contacts`
(`contacts.ts:168`) and `accounts` (`contacts.ts:70`), GIN-indexed, validated at the app edge
(ADR-0028 posture: values-in-jsonb by 100M-row rationale). Shallow-merge write semantics.

### 6.8 Provenance & verification ✅

- `field_provenance` jsonb per row (`contacts.ts:171`, `accounts` `contacts.ts:73`); descriptor
  shape `src/mth/conf/obs/pin(+pinBy/pinAt)/cf` in
  `packages/types/src/fieldProvenance.ts:19–45`; the pin-protected scalar set
  `CONTACT_PROVENANCE_FIELDS` (`fieldProvenance.ts:54`). `pin=true` blocks later overwrite.
- `last_verified_at` freshness anchor (`contacts.ts:149–153`); reveal state
  `is_revealed/revealed_by/revealed_at` (`contacts.ts:146–148`).
- Credit/cost ledgers and policy config exist as their own schema units (`contact_reveals` in
  `packages/db/src/schema/billing.ts`; `provider_calls` in `schema/intel.ts`;
  `schema/enrichmentPolicy.ts`; the bulk `enrichment_jobs` trio in `schema/enrichmentJobs.ts`).

### 6.9 Dedup & merge: markers only — nothing merges ✅

- **Automated sweep** (`packages/core/src/prospect/dedup.ts:1–9`): a soft pass keyed on
  canonical-name + registrable-domain that only sets `contacts.duplicate_of_contact_id`
  (`contacts.ts:159–164`) — “never merges or deletes rows.”
- **Admin grain-A** `execDedupMerge`
  (`packages/db/src/repositories/platformAdminWrites.ts:339–364`): maker-checker approved,
  explicit tenant+workspace predicates under `FOR UPDATE` on the RLS-bypassing owner path,
  cycle-guarded — and it writes **the same marker** (`duplicate_of_contact_id`), nothing else.
  Verified precisely: it is *marker-only annotation* — it does not move field values, does not
  re-point child rows (activities, list members, reveals), does not touch the master graph
  (“NO master-graph write — grain B remains security-review-gated”,
  `platformAdminWrites.ts:337`). Sibling `execBulkDelete` = bounded soft-delete ≤ 1000 ids
  (`platformAdminWrites.ts:374–392`).
- **Grain-B** master cluster merge/split: design-only (`pending/dedup-merge-design.md`).
- Layer-0 probabilistic ER proposes `match_links` only, shadow-gated
  (prospect-database-platform I5 — see that series).

There is **no true merge** (field union + child re-pointing + loser tombstone) anywhere.

### 6.10 History & audit ✅

Append-only `audit_log` with a closed action enum, UPDATE/DELETE blocked by trigger
(`packages/db/src/schema/billing.ts:212–233`); cross-tenant `platform_audit_log` for staff
actions. **No field-level before/after history exists** — `field_provenance` records the current
winner per field, not prior values.

### 6.11 Search 🟡

All search goes through the `SearchPort` seam; the only adapter in the repo is the in-memory
dev/test one (`packages/search/src/index.ts:1–6` — “Today: the in-memory dev/test adapter. The
OpenSearch (global) + Typesense (overlay) adapters land here behind the same interface”).
Encrypted email/phone values are never indexed; channel searchability is presence/status facets.

### 6.12 Retention, deletion, partitioning

- **Retention engine** 💤 (data-management #6): global per-class policies
  `retention_class_policies` with `disabled|shadow|enforce` and shadow-first seeds
  (`packages/db/src/schema/retention.ts:26–41`); append-only `retention_runs` evidence
  (`retention.ts:44–67`); flag-gated sweep (`packages/core/src/retention/runRetentionSweep.ts:69`).
  Seed defaults: `contacts` and `audit_log` `ttlDays: null` (never auto-delete) pending a
  legal/budget decision (`packages/types/src/retention.ts:83–84`). A **separate** staff-authored
  `retention_policies` SLA table also exists on the platform-config surface
  (`packages/db/src/schema/platformOps.ts:137–151`) — two distinct systems; do not conflate.
- **Deletion**: contacts soft-delete via `deleted_at` DSAR tombstone (`contacts.ts:165`);
  accounts hard-delete only (§6.5).
- **Partitioning** 🔲: monthly range-partitioning is a documented intent, not built, on
  `source_imports` (`contacts.ts:240–242`) and `import_job_rows` (`importJobs.ts:6–9,125–128`)
  (same note family as activities/provider_calls/enrichment_job_rows).

---

## 7. Adjacent shipped infrastructure the redesign builds on

### 7.1 Transactional outbox — shipped, not used by imports ✅/🟡

`packages/db/src/schema/workerOutbox.ts:1–40` (ADR-0027): publish-intents written in the same
tenant tx, drained leaderlessly by `apps/workers/src/outboxRelay.ts` (`FOR UPDATE SKIP LOCKED`),
at-least-once publish, consumers dedupe by stable jobId. Today its only producer is the
bulk-enrichment confirm transition (`workerOutbox.ts:2–3`). **Neither import path uses it**: the
sync API enqueues directly after commit, and the bulk finalize fires rollups best-effort from the
chunk processor (`register.ts:865–884`). (Two further outboxes exist for other domains:
`eventOutbox.ts`, `projectionOutbox.ts`.)

### 7.2 Worker-platform hardening ✅ (present at head)

All present as first-class modules in `apps/workers/src/`: `withDeadline.ts` (+ wrap at
`register.ts:587`), `tuning.ts`, `retryPolicies.ts`, `deadLetter.ts`, `metrics.ts`, `health.ts`,
`leaderLock.ts`, `outboxRelay.ts`. The `imports` queue ships retry/backoff/backpressure/DLQ (§2.1
hops 5, 9). CI verification of these is tracked in the worker-platform series, not here.

### 7.3 The two-layer feature-flag system ✅

- **Env kill-switches**: explicit-`"true"`-only booleans (`env.ts:225–230` posture).
- **Per-tenant flags**: `feature_flags` global default + per-tenant override, evaluated fail-closed
  under the tenant tx (`packages/core/src/featureFlags/flagsForTenant.ts:40–62`); staff control
  gated by `flags:manage` (`staffCapability.ts:37`).
- Bulk import is the reference **dual-gate**: env gates the router and worker construction
  (`bulkRoutes.ts:53–58`, `register.ts:848`); the tenant flag gates only job creation
  (`bulkRoutes.ts:145–149`), so an in-flight job stays pollable if a tenant is un-enrolled
  (`bulkRoutes.ts:50–52`).

### 7.4 The enrichment job trio — the pattern-sibling ✅/🌒

`import_jobs` mirrors the shipped `enrichment_jobs` trio “idiom-for-idiom” (`importJobs.ts:3–5`).
The bulk-enrichment pipeline is the closest architectural sibling: drive → chunk on a dark-gated
queue (`register.ts:909+`), confirm-before-spend, DLQ, and — **correction to the prior audit
brief** — its chunk phase is **no longer a no-op stub**: the worker wires the real
`bulkProcessEnrichChunk` (per-run cap + daily breaker) at
`apps/workers/src/queues/bulkEnrichment.ts:94–99` (header: `bulkEnrichment.ts:61–67`); the stale
“chunk body is still a NO-OP STUB until slice 3b” comment at `register.ts:906–907` predates I3's
completion and should not be read as current state. The customer job-status surface
(`GET /enrichment/jobs`, §5.4) is the read-model precedent an imports list would mirror — including
its visibility gap.

---

## 8. Status ledger

Mirrors the `16-Implementation-Audit.md` format; doc `16` takes over tracking from here.

| # | Artifact | Where | Status | Verified |
|---|---|---|---|---|
| L1 | Sync import pipeline (route → queue → worker → `runImport`) | `routes.ts` / `queue.ts` / `imports.ts` / `runImport.ts` | ✅ live | §2.1 |
| L2 | Import preview endpoint | `routes.ts:115–125` | ✅ live | §2.1 |
| L3 | Sync job durability / import history | — (Redis 24 h only; no job row, no list endpoint) | 🔲 not built | §2.1, §4.3 |
| L4 | Bulk COPY pipeline (routes, trio, drive/chunk/finalize, artifact, resume) | `bulkRoutes.ts` / `importJobs.ts` / `runBulkImport.ts` / `bulkStage.ts` / `bulkImports.ts` | 🌒 built, dark (dual-gated) | §2.2 |
| L5 | Production object store for bulk | `bulkStore.ts:16–19` | ❌ blocked (disk only) | §3.1 |
| L6 | COPY-FROM-STDIN proof | `importStagingRepository.ts:10–17` | ❌ blocked (spike unrun) | §3.2 |
| L7 | AV scanning | `bulkRoutes.ts:126–128` | ❌ blocked (permanent `skipped`) | §3.3 |
| L8 | Sync→bulk promotion threshold | `env.ts:237` (defined, unconsumed) | 🔲 not built | §4.1 |
| L9 | Owner/visibility predicate on any job list | import/reveal/enrichment/home surfaces | 🔲 not built (columns exist, unread) | §5 |
| L10 | Tenant-facing import-jobs list route | `importJobRepository.listJobsByWorkspace` | 🌒 repo method only, unrouted | §5.2 |
| L11 | Staff import monitor + data-ops reads | `admin/routes.ts:1159–1168`, `dataRoutes.ts` | ✅ live, correctly locked | §5.6 |
| L12 | Multi-value emails/phones (overlay) | — | 🔲 not built (flat columns only) | §6.2 |
| L13 | Layer-0 channel tables | `masterGraph.ts:228,259` | 🟡 shape only — blind index + domain, no values, never read by app | §6.2 |
| L14 | Account hierarchy / multi-domain / locations / soft-delete (overlay) | — | 🔲 not built | §6.5 |
| L15 | True merge (field union + child re-point) | `platformAdminWrites.ts:339–364` is marker-only | 🔲 not built (grain B design-only) | §6.9 |
| L16 | Field-level history | — (`audit_log` is action-level) | 🔲 not built | §6.10 |
| L17 | Production search adapter | `packages/search/src/index.ts:1–6` | 🔲 not built (in-memory only) | §6.11 |
| L18 | Retention engine | `retention.ts`, `runRetentionSweep.ts` | 💤 inert (flag + shadow-per-class) | §6.12 |
| L19 | High-volume partitioning (`source_imports`, `import_job_rows`) | schema comments | 🔲 intent only | §6.12 |
| L20 | Transactional outbox | `workerOutbox.ts`, `outboxRelay.ts` | ✅ shipped; 🟡 unused by imports | §7.1 |
| L21 | Per-tenant flag control plane + dual-gate pattern | `flagsForTenant.ts`, `bulkRoutes.ts` | ✅ live | §7.3 |
| L22 | Bulk-enrichment sibling (drive/chunk, spend brakes) | `bulkEnrichment.ts:94–99` | 🌒 built, dark — chunk is REAL (stale stub comment at `register.ts:906–907`) | §7.4 |

### Corrections made to the seeding brief during re-verification

1. **Bulk-enrich chunk is not a no-op stub anymore** — the brief's claim (“chunk = no-op stub,
   register.ts:902–908”) matches only a stale comment; the wired processor is
   `bulkProcessEnrichChunk` with the per-run cap and daily breaker
   (`bulkEnrichment.ts:61–67,94–99`).
2. **Layer-0 channels are emptier than described** — not merely “never joined”: the resolve path
   stores `email_enc = NULL` (blind index + domain only) and phone resolution is deferred outright
   (`masterGraphRepository.ts:15–16,27–28`), so no multi-value channel *values* exist anywhere.
3. **Grain-A “merge” is marker-only** — it does not merge-and-fail-to-re-point; it never moves any
   data at all (`platformAdminWrites.ts:330–364`).
4. **`BULK_IMPORT_THRESHOLD_ROWS` is dead config** (`env.ts:237`) — defined, documented as
   “consumed by the promotion logic”, consumed nowhere (new finding).
5. Minor line drift fixed: `master_emails` table at `masterGraph.ts:228` (not 227),
   `master_phones` at `:259` (not 258); `diskFileStore` construction at `bulkStore.ts:17`
   (function `16–19`); the contacts RLS policies span `rls/contacts.sql:17–44`.
6. `GET /admin/import-jobs` is locked by **staff roles** (`requireStaffRole`) while the newer
   data-ops surface uses **capabilities** (`requireCapability("data:read")`) — both correct, but
   designs citing “the capability gate on /admin/import-jobs” must name the role gate instead
   (`admin/routes.ts:1161` vs `dataRoutes.ts:151`).

---

¹ **Migration-number hazard (per series README):** migrations get renumbered when branches merge —
the bulk-import control-trio migration is `0032_bulk_import_jobs` *on disk at the time of writing*
while older docs call it 0024, and the per-tenant flag seed is `0034_seed_rollout_flags.sql`
*at the time of writing* (`packages/db/src/migrations/0034_seed_rollout_flags.sql:2`). Never cite
these numbers as stable identifiers; designs reference step IDs (defined in doc `15`) and the next
free number is taken at PR time.
