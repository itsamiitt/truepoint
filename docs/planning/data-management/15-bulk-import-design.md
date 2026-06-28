# 15 — Bulk COPY-staging Import Pipeline — Design (backlog #2, ADR-0036)

> Output of an orchestrated understand→design pass (7 agents). This is the on-branch design record for
> backlog **#2** so the build can proceed in safe phases. **Implementation is PHASED** (see §6) because two
> gates can't be cleared in the build sandbox: the load-bearing **COPY-FROM-STDIN streaming** primitive
> needs a `bun`+Postgres **spike**, and **no object store exists** yet (a dev disk adapter + a port ship; the
> prod S3 adapter is net-new).

## 1. The decisive architecture call

**COPY fast-loads STAGING only; the live `contacts` write stays Node-side, BATCHED per ~10k-row chunk in one
`withTenantTx`.** A pure set-based SQL merge into `contacts` was rejected on three repo facts:
1. **`ON CONFLICT` targets ONE unique index**, but the import identity ladder spans **three** partial uniques
   (`uniq_contacts_ws_email` / `_linkedin` / `_salesnav`) — one upsert can't express conflict-on-any-of-three.
2. The **pin-aware overwrite rule** lives in canonical TS (`planFieldWrite`, `prospect/fieldProvenance.ts`),
   shared with enrichment — re-expressing it as SQL `CASE` over `field_provenance` jsonb would drift a
   correctness rule by file size (CLAUDE.md: structure never overrides correctness).
3. The **co-op-safe MINT boundary** is enforced by `masterGraphRepository.resolveForImport` under `withErTx`
   (`leadwolf_er`, no overlay grant) — a set-based mint over staging would breach that trust boundary.

So COPY only fast-loads an **UNLOGGED, non-RLS** per-job staging table (Postgres forbids COPY on RLS tables),
and the merge collapses today's *1 tx + 3 SELECTs per row* into *1 tx + a handful of batched statements per
~10k chunk*. Staging carries the **already-prepared** row (ciphertext + blind index + content_hash) so PII is
encrypted even in staging and within-file dedup is pure SQL.

## 2. Pipeline

- **API**: upload file → FileStore; `importJobRepository.createJob` (idempotent on `(workspace_id, idempotency_key)`);
  enqueue `{kind:'drive', jobId, scope}` on a **dedicated** `bulk-imports` queue (never the rows). Return 202 + jobId.
- **DRIVE job**: stream-parse from FileStore (constant memory) → `validateRow` + `prepareContact` (REUSED verbatim)
  → COPY prepared rows into the per-job UNLOGGED staging table (owner connection) → within-file dedup in SQL
  (`DISTINCT ON (identity_key) ORDER BY source_row_num`, same precedence as `findByDedupKeys`) → create
  `import_job_chunks` bands (~10k by `source_row_num`) → fan out one `chunk` job per band.
- **CHUNK job** (the throughput core), all in ONE `withTenantTx`: batched against-existing dedup
  (`findByDedupKeysBatch`) → batched master resolution (`resolveForImportBatch` in one `withErTx`) → batched
  account upsert → split created-vs-matched in Node → `planFieldWrite` per matched/overwrite row (canonical pin) →
  `insertBatch`/`updateBatch` + `appendBatch(source_imports … ON CONFLICT content_hash DO NOTHING)` + list members
  + `import_job_rows` ledger + atomic counter deltas.
- **Finalize**: the LAST chunk (atomic `completed_chunks == total_chunks`) sets completed/partial, writes the
  rejected-rows artifact to FileStore, DROPs the staging table, and fires the dedup/firmographics/masterBackfill
  rollups **once**.
- **Idempotency** (3-level): job `idempotency_key`; `(job_id, chunk_index)` + terminal-skip resume watermark;
  row `content_hash`. **Accounting** (3-way): `created+matched+duplicate+skipped+rejected+deduped+unprocessed = rows_in`.
- Small uploads keep today's **synchronous `runImport`** path unchanged; a row/byte threshold + an env
  kill-switch route large uploads to bulk.

## 3. New files

`types/bulkImport.ts` (contract — **shipped**, this doc's companion) · `db/schema/importJobs.ts` ·
`db/migrations/0024_bulk_import_jobs.sql` (+ journal + snapshot) · `db/rls/importJobs.sql` ·
`db/repositories/importJobRepository.ts` · `db/repositories/importStagingRepository.ts` (all owner-connection
COPY/staging SQL) · `core/import/prepareContact.ts` (extract from `runImport`) · `core/import/streamParse.ts`
(constant-memory CSV) · `core/import/bulkStage.ts` · `core/import/bulkProcessChunk.ts` ·
`core/import/runBulkImport.ts` · `core/storage/fileStore.ts` (port + dev disk adapter) ·
`api/features/import/bulkRoutes.ts` · `api/features/import/bulkQueue.ts` · `workers/queues/bulkImport.ts`.

## 4. Changed files

`db/migrations/meta/_journal.json` (idx 24) · `db/schema/index.ts` · `db/index.ts` · `db/client.ts` (export an
**owner copy connection** for COPY on the non-RLS staging table) · `db/repositories/contactRepository.ts`
(`findByDedupKeysBatch`, `insertBatch`, `updateBatch`, `getFieldProvenanceBatch`) ·
`sourceImportRepository.ts` (`appendBatch … ON CONFLICT content_hash`) · `accountRepository.ts`
(`upsertByDomainBatch`) · `masterGraphRepository.ts` (`resolveForImportBatch` — one `withErTx`/chunk) ·
`core/import/runImport.ts` (use the extracted `prepareContact`) · `core/index.ts` · `types/index.ts` ·
`config/env.ts` (object-store + `BULK_IMPORT_ENABLED` + thresholds) · `api/features/import/routes.ts`
(mount + threshold-gate) · `workers/register.ts` (queue + worker + DLQ + once-per-job rollup hook).

## 5. Migration (pure EXPAND)

`0024_bulk_import_jobs` creates the control trio **`import_jobs` / `import_job_chunks` / `import_job_rows`**,
mirroring the shipped enrichment trio (varchar+CHECK enums, `uuid_generate_v7`, partial-unique
`idempotency_key`, `(job_id, chunk_index)` unique, denormalized `workspace_id` on the high-volume rows table,
NULLIF-fail-closed RLS, chunks scoped through parent). **No DDL change** to `contacts`/`accounts`/`source_imports`
— the merge reuses their existing partial-unique indexes + `field_provenance`/`content_hash` machinery. Per-job
UNLOGGED **non-RLS** staging tables are created/dropped at RUNTIME (not in the migration). Reversible: flag off
(staging non-destructive + chunks watermark-resumable); revert-by-batch via `source_imports` provenance.

## 6. Build phases (safe → gated)

1. **Contract** — `types/bulkImport.ts` (**done**).
2. **Control plane — ✅ DONE** — `schema/importJobs.ts` (`import_jobs`/`_chunks`/`_rows`) + migration **0024**
   + `rls/importJobs.sql` + `importJobRepository` (idempotent create, atomic counter deltas, race-free
   `incrementCompletedChunks`) + RLS-isolation itest. Mirrors the proven `verification_jobs`/`data_quality_snapshots`/
   enrichment trio (no COPY, no object store). CI exercises migrate 0024 + the RLS isolation; `drizzle-kit generate`
   confirms the hand-authored 0024 snapshot.
3. **Core primitives — ◑ mostly done** — `streamParse` (constant-memory CSV; byte-identical quoting parity to
   `parseFile`), `fileStore` (port + local-disk dev adapter), and the batch repo methods (`findByDedupKeysBatch`,
   `insertBatch`, `updateBatch`, `getFieldProvenanceBatch`, `sourceImport.appendBatch`, `account.upsertByDomainBatch`,
   `masterGraph.resolveForImportBatch`) shipped — additive, semantics-preserving. The `prepareContact` extraction
   (parity-critical, touches `runImport`) is deferred to phase 5 to land + verify alongside its consumer `bulkStage`.
4. **⚠ Gated — COPY spike** — prove `postgres.js` COPY-FROM-STDIN streaming on a non-RLS UNLOGGED table over the
   owner connection (needs `bun`+Postgres). Blocks the staging repo + stage phase.
5. **Pipeline** — `importStagingRepository`, `bulkStage`, `bulkProcessChunk`, `runBulkImport`.
6. **Wiring + rollout** — API routes/queue, worker, `register.ts`; behind `BULK_IMPORT_ENABLED` (off) + the
   existing per-tenant flag system + shadow mode; then the plan-tier threshold routes large uploads to bulk.

## 7. Open questions (need a human / a gated env)

- **Object store**: presigned-S3-multipart vs API-buffered-to-FileStore for MVP; AV-scan-before-promote gate
  (G-IMP-6) required? **No object store exists today** — an adapter must be chosen/wired.
- **COPY spike**: `postgres.js` COPY streaming is unproven here (zero `sql.copy` usage in the repo) — spike before committing the staging design.
- **Plan-tier threshold** (sync→bulk promotion): owned by settings/billing — TBD.
- **Chunk execution**: per-band BullMQ fan-out vs sequential (pool-pressure trade-off); chunk size ~10k is a target, not locked.
- **XLSX at scale**: SheetJS can't stream — keep on the sync path, server-convert to CSV, or block above the threshold.
- **Staging role/DDL**: dedicated `leadwolf_copy` role vs the existing owner connection; per-job CREATE/DROP DDL rate vs a shared job_id-partitioned staging table.

> **Correction to one design premise:** the synthesize step flagged "no `feature_flags` primitive exists" — that
> is **wrong**. A per-tenant feature-flag system shipped earlier this branch (`data_health.reverification` via
> `isFlagEnabledForTenant` + the `feature_flags` table). Per-tenant bulk-import gating **reuses it** — not a blocker.

## 8. Risks (carried from the design)

Staging is non-RLS → isolation drops to access-path + an explicit `job_id`+`workspace_id` predicate on every
staging query (a forgotten predicate leaks across workspaces — needs a focused isolation test, all staging access
confined to `importStagingRepository` on the owner connection). · `staging.raw_data` holds plaintext PII
transiently (non-RLS UNLOGGED) for `source_imports` provenance — REVOKE + DROP-on-complete + the (unbuilt)
AV gate. · COPY streaming/backpressure unproven (spike). · The two-survivors-sharing-a-secondary-key edge across
chunks (mitigated by within-file `DISTINCT ON` + Node-resolved new-vs-matched + chunk retry + the dedup worker).
· Two import paths double the test surface — enforced against by the shared `prepareContact` + a bulk-vs-sync
parity test. · Hand-authored 0024.sql can drift from `schema/importJobs.ts` — CI `drizzle-kit generate` + typecheck must confirm.
