// bulkImport.ts — Zod schemas + inferred types + queue constants for the bulk COPY-staging import pipeline
// (backlog #2, ADR-0036; design in docs/planning/data-management/15-bulk-import-design.md). Single source of
// truth shared by apps/api (producer), apps/workers (consumer), and apps/web (the polling UI), so producer and
// consumer can never drift — and so apps never import apps (mirrors IMPORTS_QUEUE / bulkEnrichment.ts). The
// per-row PII/identity/merge logic lives in core; this file is the transport + status contract only.

import { z } from "zod";

// ── Queue names (shared producer/consumer) ──────────────────────────────────────────────────────────────
/** The dedicated BullMQ queue for bulk imports — separate from the inline `imports` queue so its
 *  concurrency / DLQ / completed-hook never contend with the synchronous small-file path. */
export const BULK_IMPORTS_QUEUE = "bulk-imports";
/** Dead-letter queue for bulk-import jobs that exhaust their retries. Shared producer/consumer. */
export const BULK_IMPORTS_DLQ = "bulk-imports-dlq";

// ── Rollout gate ─────────────────────────────────────────────────────────────────────────────────────────
/** Per-tenant feature-flag key for the bulk import pipeline (existing feature-flag system; default false →
 *  fail-closed). The TWO-LAYER gate: the global env.BULK_IMPORT_ENABLED kill-switch must be on AND this
 *  per-tenant flag must be enabled for the caller's tenant before a bulk import is accepted. Mirrors
 *  RETENTION_ENGINE_FLAG_KEY (retention.ts) — the shared key lives here so api/workers can never drift. */
export const BULK_IMPORT_FLAG_KEY = "bulk_import_enabled";

// ── Enums ────────────────────────────────────────────────────────────────────────────────────────────────
/** Lifecycle of a bulk-import job. `validating`→`staged` covers the COPY-stage + within-file dedup; `running`
 *  covers chunk fan-out; `partial` = completed with some rejected/errored rows; `paused` for a budget/ops hold. */
export const bulkImportJobStatus = z.enum([
  "queued",
  "validating",
  "staged",
  "running",
  "paused",
  "completed",
  "partial",
  "failed",
  "cancelled",
]);
export type BulkImportJobStatus = z.infer<typeof bulkImportJobStatus>;

/** AV-scan gate for an untrusted upload (G-IMP-6). `skipped` when AV is not configured; the promote-to-staging
 *  step refuses an `infected` file. A seam today — the scanner is wired at the composition root later. */
export const avScanStatus = z.enum(["pending", "clean", "infected", "skipped"]);
export type AvScanStatus = z.infer<typeof avScanStatus>;

/** Terminal outcome of one input row in the bulk merge (the import_job_rows ledger + the three-way tally). */
export const bulkImportRowOutcome = z.enum([
  "created",
  "matched",
  "duplicate",
  "skipped",
  "rejected",
  "unprocessed",
]);
export type BulkImportRowOutcome = z.infer<typeof bulkImportRowOutcome>;

// ── Job payload (queue) ──────────────────────────────────────────────────────────────────────────────────
/** The workspace scope every bulk-import job carries (the worker re-enters withTenantTx with it). */
export const bulkImportScopeSchema = z.object({
  tenantId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});
export type BulkImportScope = z.infer<typeof bulkImportScopeSchema>;

/** The discriminated job payload — jobId + scope ONLY (NEVER the rows; file bytes live in the FileStore). A
 *  `drive` job stages the file + fans out `chunk` jobs; a `chunk` job merges one staged band. */
export const bulkImportJobDataSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("drive"), jobId: z.string().uuid(), scope: bulkImportScopeSchema }),
  z.object({
    kind: z.literal("chunk"),
    jobId: z.string().uuid(),
    scope: bulkImportScopeSchema,
    chunkId: z.string().uuid(),
  }),
]);
export type BulkImportJobData = z.infer<typeof bulkImportJobDataSchema>;

// ── Status / accounting DTOs (customer-visible; non-PII) ─────────────────────────────────────────────────
/** The 202 accept-response when a bulk import is taken for background processing: a job ref to poll. */
export const bulkImportJobRefSchema = z.object({ jobId: z.string(), status: bulkImportJobStatus });
export type BulkImportJobRef = z.infer<typeof bulkImportJobRefSchema>;

/** Three-way row accounting off the import_jobs control row: rows_in = the sum of these. Non-PII counts only. */
export const importJobCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  deduped: z.number().int().nonnegative(),
  unprocessed: z.number().int().nonnegative(),
});
export type ImportJobCounts = z.infer<typeof importJobCountsSchema>;

/** The polled status of a bulk-import job (GET /imports/bulk/:jobId): counters + file name + timestamps. Non-PII. */
export const bulkImportJobStatusResponseSchema = z.object({
  jobId: z.string(),
  sourceName: z.string(),
  status: bulkImportJobStatus,
  progress: z.number().min(0).max(1), // completed_chunks ÷ total_chunks (0 when total is 0)
  counts: importJobCountsSchema,
  rejectedRowsUrl: z.string().nullable(), // signed download for the rejected-rows artifact, once finalized
  createdAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  failedReason: z.string().nullable(),
});
export type BulkImportJobStatusResponse = z.infer<typeof bulkImportJobStatusResponseSchema>;

/** PII-free dead-letter for a bulk-import job that exhausts retries (scope + source + reason only).
 *  `fast` joins the kind vocabulary with the unified-queue fast lane (importV2.ts, S-I3) — additive; the
 *  drive/chunk record shape is unchanged. */
export const bulkImportDeadLetterSchema = z.object({
  jobId: z.string(),
  tenantId: z.string(),
  workspaceId: z.string(),
  sourceName: z.string(),
  kind: z.enum(["drive", "chunk", "fast"]),
  reason: z.string(),
});
export type BulkImportDeadLetter = z.infer<typeof bulkImportDeadLetterSchema>;
