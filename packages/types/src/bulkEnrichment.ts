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
