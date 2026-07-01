// bulkEnrichment.ts — the Zod schemas + inferred types + queue constants for the bulk CSV enrichment
// pipeline. Single source of truth shared by apps/api (producer), apps/workers (consumer), and apps/web
// (the polling UI), so producer and consumer can never drift. Mirrors the import-pipeline contracts in
// contacts.ts exactly: enums first, then options/refs, then the queue DTOs. Validation lives here; logic
// does not. emailStatus reuses the existing email_status value set (contacts.ts) — never re-derive it.

import { z } from "zod";

// ── Queue names (shared producer/consumer) ──────────────────────────────────────────────────────────────
/**
 * The BullMQ queue name shared by the API *producer* (apps/api bulk-enrich slice) and the workers
 * *consumer* (apps/workers). It lives here, in the leaf types package both apps already depend on, so the
 * producer and consumer can never drift — and so apps never import apps (mirrors IMPORTS_QUEUE).
 */
export const BULK_ENRICHMENT_QUEUE = "bulk-enrichment";

/** Dead-letter queue name for bulk-enrichment jobs that exhaust their retries. Shared producer/consumer. */
export const BULK_ENRICHMENT_DLQ = "bulk-enrichment-dlq";

// ── Rollout gate ─────────────────────────────────────────────────────────────────────────────────────────
/** Per-tenant feature-flag key for the bulk CSV enrichment pipeline (existing feature-flag system; default
 *  false → fail-closed). The TWO-LAYER gate: the global env.BULK_ENRICHMENT_ENABLED kill-switch must be on AND
 *  this per-tenant flag must be enabled for the caller's tenant before a confirmed bulk-enrich run releases its
 *  spend. Mirrors BULK_IMPORT_FLAG_KEY (bulkImport.ts) — the shared key lives here so api/workers never drift. */
export const BULK_ENRICHMENT_FLAG_KEY = "bulk_enrichment_enabled";

// ── Queue message (producer/consumer contract) ──────────────────────────────────────────────────────────
/** The workspace scope every bulk-enrichment job carries (the worker re-enters withTenantTx with it). */
export const bulkEnrichmentScopeSchema = z.object({
  tenantId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});
export type BulkEnrichmentScope = z.infer<typeof bulkEnrichmentScopeSchema>;

/**
 * The discriminated queue payload — jobId + scope ONLY (NEVER the rows; the source file lives in the FileStore
 * and the per-row ledger in the DB). A `drive` job chunks a CONFIRMED job + fans out `chunk` jobs; a `chunk` job
 * enriches one staged band. Mirrors bulkImportJobDataSchema exactly (one implementation shape, two pipelines) so
 * the apps/api producer and the apps/workers consumer can never drift. The producer only ever enqueues `drive`.
 */
export const bulkEnrichmentJobDataSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("drive"), jobId: z.string().uuid(), scope: bulkEnrichmentScopeSchema }),
  z.object({
    kind: z.literal("chunk"),
    jobId: z.string().uuid(),
    scope: bulkEnrichmentScopeSchema,
    chunkId: z.string().uuid(),
  }),
]);
export type BulkEnrichmentJobData = z.infer<typeof bulkEnrichmentJobDataSchema>;

/**
 * The PII-FREE dead-letter record for a bulk-enrich job that EXHAUSTED its retries (ops triage). Scope + job id +
 * kind + reason only — never rows/PII (the queue payload is already PII-free). Mirrors bulkImportDeadLetterSchema.
 */
export const bulkEnrichmentDeadLetterSchema = z.object({
  jobId: z.string(),
  tenantId: z.string(),
  workspaceId: z.string(),
  kind: z.string(),
  reason: z.string(),
});
export type BulkEnrichmentDeadLetter = z.infer<typeof bulkEnrichmentDeadLetterSchema>;

// ── Enums ────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Lifecycle of a bulk-enrichment job. `queued` is what the 202 accept-response reports at enqueue time;
 * `estimating` → `awaiting_confirmation` covers the pre-flight cost estimate the user must confirm before
 * any credits are spent; `running` ↔ `paused` covers in-flight execution (e.g. budget pause).
 */
export const enrichmentJobStatus = z.enum([
  "queued",
  "estimating",
  "awaiting_confirmation",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export type EnrichmentJobStatus = z.infer<typeof enrichmentJobStatus>;

/** How a row was matched to a contact — deterministic keys first (cheapest, highest trust), then fuzzy, then provider. */
export const matchMethod = z.enum([
  "deterministic_email",
  "deterministic_linkedin",
  "deterministic_phone",
  "deterministic_domain",
  "fuzzy_name_company",
  "provider",
  "none",
]);
export type MatchMethod = z.infer<typeof matchMethod>;

/** The terminal outcome of attempting to match + enrich a single row. */
export const matchOutcome = z.enum([
  "matched_internal",
  "matched_provider",
  "unmatched",
  "suppressed",
  "error",
]);
export type MatchOutcome = z.infer<typeof matchOutcome>;

/**
 * Email field correctness — reuses the existing email_status value set (contacts.ts emailStatus); never
 * re-derive. Kept module-local (not exported) so the barrel has a single `emailStatus` symbol of record —
 * contacts.ts owns the exported one. This Wave-1 unit deliberately does not import sibling units, so the
 * value set is mirrored here; a single-source-of-truth merge happens when the units are wired together.
 */
const bulkEmailStatus = z.enum(["unverified", "valid", "risky", "invalid", "catch_all", "unknown"]);

// ── Job options (set at submit time; drive cost + matching behavior) ─────────────────────────────────────
/** Caller-controlled knobs for a bulk-enrichment run. Minimal + sensible defaults; costs are in micros. */
export const bulkEnrichmentOptionsSchema = z.object({
  providersEnabled: z.boolean(), // allow paid provider fallback when internal match fails
  parallelCheapMode: z.boolean(), // run the cheap deterministic passes in parallel before any provider call
  confidenceThreshold: z.number().min(0).max(1), // min match confidence to accept (0–1)
  maxProviderCostMicros: z.number().int().nonnegative().optional(), // hard cap on provider spend, in micros
});
export type BulkEnrichmentOptions = z.infer<typeof bulkEnrichmentOptionsSchema>;

// ── Job ref / estimate / progress DTOs ───────────────────────────────────────────────────────────────────
/** The 202 accept-response when a bulk enrichment is taken for background processing: a job ref to poll. */
export const bulkEnrichJobRefSchema = z.object({
  jobId: z.string(),
  status: enrichmentJobStatus,
});
export type BulkEnrichJobRef = z.infer<typeof bulkEnrichJobRefSchema>;

/** The pre-flight estimate shown for confirmation before any credits are spent. Cost is in micros. */
export const bulkEnrichEstimateSchema = z.object({
  rowCount: z.number().int().nonnegative(),
  estimatedMatchRate: z.number().min(0).max(1), // expected fraction of rows matched (0–1)
  estimatedCreditMicros: z.number().int().nonnegative(),
});
export type BulkEnrichEstimate = z.infer<typeof bulkEnrichEstimateSchema>;

/** Coarse progress the worker reports via job.updateProgress; the status endpoint echoes it back. */
export const bulkEnrichProgressSchema = z.object({
  total: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  enriched: z.number().int().nonnegative(),
  charged: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type BulkEnrichProgress = z.infer<typeof bulkEnrichProgressSchema>;

/** Per-row outcome of the bulk run (drives the downloadable result file + the matched/enriched tally). */
export const bulkEnrichRowResultSchema = z.object({
  rowIndex: z.number().int().nonnegative(), // 0-based index in the parsed file
  matchMethod: matchMethod,
  matchOutcome: matchOutcome,
  matchConfidence: z.number().min(0).max(1).optional(),
  enrichedFields: z.array(z.string()).optional(),
  providerSource: z.string().optional(),
  emailStatus: bulkEmailStatus.optional(),
});
export type BulkEnrichRowResult = z.infer<typeof bulkEnrichRowResultSchema>;

// ── Async bulk-enrichment job (queue) status DTO ─────────────────────────────────────────────────────────
/**
 * The polled status of a bulk-enrichment job (GET /bulk-enrich/:jobId). Mirrors importJobStatusResponse:
 * `progress`/`estimate`/`downloadUrl`/`failedReason` fill in across the lifecycle (estimate before
 * confirmation, progress while running, downloadUrl once the result file is ready, failedReason on failure).
 */
export const bulkEnrichJobStatusResponseSchema = z.object({
  jobId: z.string(),
  status: enrichmentJobStatus,
  progress: bulkEnrichProgressSchema.nullable(),
  estimate: bulkEnrichEstimateSchema.nullable(),
  downloadUrl: z.string().nullable(),
  failedReason: z.string().nullable(),
});
export type BulkEnrichJobStatusResponse = z.infer<typeof bulkEnrichJobStatusResponseSchema>;

// ── Customer-visible enrichment job-status surface (G-ENR-4; 06 §4.1, 31 §8) ─────────────────────────────
// A READ-only surface so a workspace user can see their enrichment jobs with live status, progress, the
// matched/enriched/charged + failed counts, timestamps, and the failure reason. These are the projection the
// jobs LIST and DETAIL endpoints (GET /enrichment/jobs[/:jobId]) return; they carry NO PII (just the control
// row's counters + file name + timestamps), so they are safe to poll into the browser. Additive — the queue
// DTOs above stay the producer/consumer contract; these are the customer status view.

/**
 * The matched/enriched/charged + failed-row counts pulled off the `enrichment_jobs` control row. `failed` is
 * derived — rows that were neither matched nor still pending = `processed - matched` once a job is settled —
 * so the surface can show "how many rows didn't resolve" without reading the high-volume per-row ledger.
 */
export const enrichmentJobCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  enriched: z.number().int().nonnegative(),
  charged: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type EnrichmentJobCounts = z.infer<typeof enrichmentJobCountsSchema>;

/**
 * One row in the customer-facing jobs list: identity + the original file name, lifecycle status, a 0–1
 * progress fraction (processed ÷ total, 0 when total is 0), the counts, the credit estimate/spend (micros),
 * the lifecycle timestamps, and the failure reason (set only when `status = failed`). Non-PII: serializable.
 */
export const enrichmentJobSummarySchema = z.object({
  jobId: z.string(),
  sourceName: z.string(),
  status: enrichmentJobStatus,
  progress: z.number().min(0).max(1), // processed ÷ total (0 when total is 0)
  counts: enrichmentJobCountsSchema,
  creditEstimateMicros: z.number().int().nonnegative().nullable(),
  creditSpentMicros: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  failedReason: z.string().nullable(),
});
export type EnrichmentJobSummary = z.infer<typeof enrichmentJobSummarySchema>;

/** The jobs LIST response (GET /enrichment/jobs): most-recent first, capped server-side. */
export const enrichmentJobListResponseSchema = z.object({
  jobs: z.array(enrichmentJobSummarySchema),
});
export type EnrichmentJobListResponse = z.infer<typeof enrichmentJobListResponseSchema>;

/** The job DETAIL response (GET /enrichment/jobs/:jobId): the same summary, one job. */
export const enrichmentJobDetailResponseSchema = enrichmentJobSummarySchema;
export type EnrichmentJobDetailResponse = z.infer<typeof enrichmentJobDetailResponseSchema>;
