// realtimeEvents.ts — the shared contract for the Phase 4 realtime backbone (ADR-0027), imported by the reveal
// tx (append), the relay (publish), the SSE route (fan-out), and the web client (reconcile) so none of them
// drift. Events are PII-FREE (ids + counts + status only). The Redis pub/sub channel + the SSE `event:` name
// are one workspace-scoped topic; the outbox `id` (v7 uuid) is the SSE `id:` / last-event-id for gap-free resume.

import { z } from "zod";

// ── Event types (the `event_outbox.event_type` + SSE `event:` name) ──────────────────────────────────────
export const EVENT_REVEAL_COMPLETED = "reveal.completed";
export const EVENT_CREDITS_CHANGED = "credits.changed";
export const EVENT_REVEAL_JOB_PROGRESS = "reveal.job.progress";
export const EVENT_REVEAL_JOB_COMPLETED = "reveal.job.completed";

// ── Import v2 job events (import-redesign 09 §4.4, S-Q6) — names RESERVED, wiring DARK ───────────────────
// No producer writes these yet: the outbox writers land with S-Q3 and stay behind the untouched
// REALTIME_SSE_ENABLED gate. Reserved now so payload shapes are stable when wiring lands, and so poll and
// SSE can never diverge — both derive from the SAME durable counters via core's deriveImportProgress.
// Polling remains the documented safety net (03's market posture): no client behavior may REQUIRE these.
export const EVENT_IMPORT_JOB_STATE_CHANGED = "import.job.state_changed";
/** Producer-throttled to ≥ one outbox row per IMPORT_JOB_PROGRESS_THROTTLE_MS per job (never per batch) —
 *  event volume stays O(duration), not O(rows). Mirrors core's IMPORT_PROGRESS_MIN_INTERVAL_MS. */
export const EVENT_IMPORT_JOB_PROGRESS = "import.job.progress";
/** Terminal set — one event per job-terminal, ever (stable-key dedupe downstream, 09 §6.3). */
export const EVENT_IMPORT_JOB_COMPLETED = "import.job.completed";
export const EVENT_IMPORT_JOB_PARTIAL = "import.job.partial";
export const EVENT_IMPORT_JOB_FAILED = "import.job.failed";
export const EVENT_IMPORT_JOB_CANCELLED = "import.job.cancelled";

/** The progress event's producer throttle window (09 §4.4). Kept beside the event name it governs; core's
 *  IMPORT_PROGRESS_MIN_INTERVAL_MS carries the same value for the write-side cadence. */
export const IMPORT_JOB_PROGRESS_THROTTLE_MS = 2_000;

/** The Redis pub/sub channel a workspace's live events fan out on (one topic per workspace). */
export function workspaceEventChannel(workspaceId: string): string {
  return `rt:ws:${workspaceId}`;
}

/** The message published to Redis pub/sub AND streamed as an SSE data frame. PII-free by contract. */
export const realtimeEventSchema = z.object({
  id: z.string().uuid(), // = event_outbox.id (v7) → SSE id: / Last-Event-ID
  type: z.string(),
  workspaceId: z.string().uuid(),
  payload: z.record(z.unknown()),
});
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

// ── Payload shapes (documentation + client narrowing; all PII-free) ──────────────────────────────────────
/** reveal.completed — a single-reveal committed. The client refreshes that contact + the balance. */
export interface RevealCompletedPayload {
  contactId: string;
  revealType: string;
  creditsCharged: number;
  alreadyOwned: boolean;
  balanceAfter: number;
}

/** credits.changed — the tenant balance moved (grant / bulk lease / release / credit-back). */
export interface CreditsChangedPayload {
  balanceAfter: number;
}

/** reveal.job.progress / reveal.job.completed — the async bulk job's live counters. */
export interface RevealJobProgressPayload {
  jobId: string;
  status: string;
  processedContacts: number;
  totalContacts: number;
  revealedContacts: number;
}

// ── Import v2 payload shapes (09 §4.4; PII-free by the outbox contract — ids, counts, statuses only) ─────
/** import.job.state_changed — any observable transition of a durable import job. */
export interface ImportJobStateChangedPayload {
  jobId: string;
  status: string;
  previousStatus: string;
}

/** The non-PII counter snapshot the progress + terminal events carry (mirrors ImportJobCounts). */
export interface ImportJobCountersSnapshot {
  total: number;
  created: number;
  matched: number;
  duplicate: number;
  skipped: number;
  rejected: number;
  deduped: number;
  unprocessed: number;
}

/** import.job.progress — throttled durable-counter snapshot (poll's ETag-shaped twin, never row data). */
export interface ImportJobProgressPayload {
  jobId: string;
  countersSnapshot: ImportJobCountersSnapshot;
  completedChunks: number;
  totalChunks: number;
}

/** import.job.completed|partial|failed|cancelled — the terminal event (09 §4.4's terminal set). */
export interface ImportJobTerminalPayload {
  jobId: string;
  counters: ImportJobCountersSnapshot;
  artifactAvailable: boolean;
}
