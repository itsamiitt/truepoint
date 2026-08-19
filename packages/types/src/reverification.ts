// reverification.ts — the SHARED queue contract for freshness re-verification (ADR-0025, 22 §3/§4). The queue
// NAME + the job-data schema/type live in the LEAF types package so the producer (apps/workers' daily sweep AND
// apps/api's on-demand trigger — data-management #3 follow-up) and the consumer (apps/workers' processor) can
// never drift, and so apps never import apps (mirrors BULK_IMPORTS_QUEUE / bulkImport.ts). The per-workspace
// re-grade logic lives in @leadwolf/core's runReverification; this file is the transport contract only. Moving
// the const/type here is BEHAVIOR-PRESERVING: the queue name string is unchanged, so existing queued jobs + the
// worker still match.

import { z } from "zod";

// ── Queue name (shared producer/consumer) ──────────────────────────────────────────────────────────────────
/** The BullMQ queue for per-workspace freshness re-verification (ADR-0025). Shared producer/consumer. */
export const REVERIFICATION_QUEUE = "reverification";
/** Dead-letter holding queue for re-verification jobs that exhaust their retries (PII-free records). Lives
 *  here beside the queue name it belongs to (mirrors IMPORTS_DLQ in contacts.ts). */
export const REVERIFICATION_DLQ = "reverification-dlq";

// ── Job payload (queue) ─────────────────────────────────────────────────────────────────────────────────────
/** The workspace scope a re-verification job carries (the worker re-enters withTenantTx with it). */
export const reverificationScopeSchema = z.object({
  tenantId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});
export type ReverificationScope = z.infer<typeof reverificationScopeSchema>;

/** The keyset checkpoint a run persists after each completed batch (perf-audit P1.3): `sortKey` is the ISO
 *  form of `coalesce(last_verified_at, created_at)` — serialized because job data crosses Redis as JSON.
 *  A deadline-killed attempt's retry resumes FROM here instead of re-scanning (and re-paying) the workspace
 *  from the top; rows the killed attempt already stamped left the stale set, so the resumed read is exact. */
export const reverificationCursorSchema = z.object({
  sortKey: z.string().min(1),
  id: z.string().uuid(),
});
export type ReverificationCursor = z.infer<typeof reverificationCursorSchema>;

/** The job payload: the workspace scope to re-verify + an optional keyset batch size (defaults in core) +
 *  the resume checkpoint the WORKER writes back onto the job after each batch (producers never set it). */
export const reverificationJobDataSchema = z.object({
  scope: reverificationScopeSchema,
  batchSize: z.number().int().positive().optional(),
  resumeCursor: reverificationCursorSchema.optional(),
});
export type ReverificationJobData = z.infer<typeof reverificationJobDataSchema>;

// ── Trigger ack (api → web) ─────────────────────────────────────────────────────────────────────────────────
/** The 202 ack the on-demand trigger returns: confirmation + the queued job ref (data-management #3 follow-up). */
export const reverificationTriggerAckSchema = z.object({
  queued: z.literal(true),
  jobId: z.string(),
});
export type ReverificationTriggerAck = z.infer<typeof reverificationTriggerAckSchema>;
