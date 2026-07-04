// bulkReveal.ts — the shared contract for the ASYNC bulk-reveal job (Phase 3, ADR-0029/0036). Mirrors
// bulkEnrichment.ts: the BullMQ queue/DLQ names + the per-tenant flag key (so apps/api producer and
// apps/workers consumer never drift), the job-data discriminated union (drive → plan+enqueue chunks; chunk →
// reveal a row band), the create/estimate request shapes, and the PII-free customer status DTOs the reveal-jobs
// UI polls. The heavy work runs on a worker; credits are reserved once (lease) at confirm and the remainder
// released at finalize (never a per-row hot-lock on the tenant counter — the ADR-0029 reserve-then-settle rule).

import { z } from "zod";
import { revealType } from "./billing.ts";
import { jobCreatedBySchema } from "./jobVisibility.ts";
import { contactQuery } from "./search.ts";

// ── Queue + flag identifiers (the single source both api + workers import) ───────────────────────────────
export const BULK_REVEAL_QUEUE = "bulk-reveal";
export const BULK_REVEAL_DLQ = "bulk-reveal-dlq";
/** Per-tenant feature flag key (checked with the global env.BULK_REVEAL_ENABLED kill-switch). */
export const BULK_REVEAL_FLAG_KEY = "bulk_reveal_enabled";

// ── Job + per-row state machines (varchar + CHECK in the schema; enums here) ─────────────────────────────
export const revealJobStatus = z.enum([
  "queued",
  "estimating",
  "awaiting_confirmation",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export type RevealJobStatus = z.infer<typeof revealJobStatus>;

/** Terminal states — a poller stops once every tracked job is here. */
export const REVEAL_JOB_TERMINAL: ReadonlySet<RevealJobStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** Per-contact outcome. Starts `queued`; a chunk drives it to exactly one terminal outcome. */
export const revealJobRowOutcome = z.enum([
  "queued",
  "revealed",
  "already_owned",
  "suppressed",
  "insufficient",
  "error",
]);
export type RevealJobRowOutcome = z.infer<typeof revealJobRowOutcome>;

// ── Worker job data (discriminated on `kind`) ────────────────────────────────────────────────────────────
export const bulkRevealScopeSchema = z.object({
  tenantId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});
export type BulkRevealScope = z.infer<typeof bulkRevealScopeSchema>;

export const bulkRevealJobDataSchema = z.discriminatedUnion("kind", [
  // drive: plan the row bands + enqueue one chunk each (or resume the not-yet-done bands).
  z.object({ kind: z.literal("drive"), jobId: z.string().uuid(), scope: bulkRevealScopeSchema }),
  // chunk: reveal the `queued` rows whose row_index ∈ [rowStart, rowEnd).
  z.object({
    kind: z.literal("chunk"),
    jobId: z.string().uuid(),
    scope: bulkRevealScopeSchema,
    rowStart: z.number().int().min(0),
    rowEnd: z.number().int().min(0),
  }),
]);
export type BulkRevealJobData = z.infer<typeof bulkRevealJobDataSchema>;

/** DLQ payload — PII-free (ids + the error shape only). */
export const bulkRevealDeadLetterSchema = z.object({
  jobId: z.string().uuid(),
  kind: z.enum(["drive", "chunk"]),
  reason: z.string(),
  failedAt: z.string().datetime({ offset: true }),
});
export type BulkRevealDeadLetter = z.infer<typeof bulkRevealDeadLetterSchema>;

// ── API request shapes ───────────────────────────────────────────────────────────────────────────────────
/** Create a bulk-reveal job over an explicit selection OR a select-all-matching query (resolved to ids at
 *  submit). Exactly one of contactIds / criteria — the async path is what lets reveal work on select-all. */
export const bulkRevealCreateSchema = z
  .object({
    revealType: revealType,
    contactIds: z.array(z.string().uuid()).min(1).max(50_000).optional(),
    criteria: contactQuery.optional(),
  })
  .refine((v) => (v.contactIds ? !v.criteria : !!v.criteria), {
    message: "Provide exactly one of { contactIds | criteria }.",
  });
export type BulkRevealCreate = z.infer<typeof bulkRevealCreateSchema>;

// ── Customer status DTOs (PII-free: counts + credits + timestamps) ───────────────────────────────────────
export const revealJobSummarySchema = z.object({
  id: z.string().uuid(),
  revealType: revealType,
  status: revealJobStatus,
  totalContacts: z.number().int().min(0),
  processedContacts: z.number().int().min(0),
  revealedContacts: z.number().int().min(0),
  alreadyOwnedContacts: z.number().int().min(0),
  suppressedContacts: z.number().int().min(0),
  failedContacts: z.number().int().min(0),
  /** Worst-case reservation shown at confirm (credits). */
  creditEstimate: z.number().int().min(0),
  /** Actually charged so far (credits). */
  creditSpent: z.number().int().min(0),
  /** A revealed CSV is ready to download (terminal + a result file was written). */
  resultReady: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  /** Creator attribution (import-redesign 10 §2.1) — present ONLY while the job-visibility dual gate is on
   *  for the tenant (absent flag-off ⇒ byte-identical legacy responses, T-V4). */
  createdBy: jobCreatedBySchema.optional(),
});
export type RevealJobSummary = z.infer<typeof revealJobSummarySchema>;

export const revealJobsListResponseSchema = z.object({ jobs: z.array(revealJobSummarySchema) });
export type RevealJobsListResponse = z.infer<typeof revealJobsListResponseSchema>;

/** The estimate a create returns before confirm — worst-case ceiling + how many are already owned (free). */
export const revealJobEstimateSchema = z.object({
  jobId: z.string().uuid(),
  revealType: revealType,
  totalContacts: z.number().int().min(0),
  /** Contacts that will actually be charged in the worst case (own the field → free). */
  billableContacts: z.number().int().min(0),
  alreadyOwnedContacts: z.number().int().min(0),
  /** Worst-case credits (billableContacts × per-type cost). */
  projectedMaxCredits: z.number().int().min(0),
  balance: z.number().int().min(0),
  balanceAfter: z.number().int().min(0),
  sufficient: z.boolean(),
});
export type RevealJobEstimate = z.infer<typeof revealJobEstimateSchema>;
