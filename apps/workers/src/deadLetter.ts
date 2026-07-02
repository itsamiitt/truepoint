// deadLetter.ts — generic PII-FREE dead-letter routing for the event queues (worker-platform plan 15 §2.2,
// item 0.2). Mirrors the imports pattern (queues/imports.ts deadLetterFailedImport): a job that has EXHAUSTED
// its retries is recorded on a per-queue dead-letter queue for ops triage instead of sitting invisibly in the
// BullMQ failed set; a job with retries remaining is left alone (BullMQ will retry it).
//
// THE PII RULE (12-security-review.md; truepoint-security data-protection): the record NEVER copies `job.data`.
// Payloads hold PII — dsar carries a subject email that must never be persisted outside the job itself, imports
// carry raw rows, outreach references contacts. Only the identifying scope (tenant/workspace UUIDs, when the
// payload exposes them), the job id/name, the error message, and the attempt count are recorded.

import type { Job, Queue } from "bullmq";
import { log } from "./logger.ts";

/** A PII-free dead-letter record: scope + provenance + reason only — never the payload. */
export interface WorkerDeadLetter {
  queue: string;
  originalJobId: string;
  jobName: string;
  failedReason: string;
  attemptsMade: number;
  tenantId: string | null;
  workspaceId: string | null;
}

/** Pull the tenant/workspace scope out of a job payload without copying anything else. Handles both payload
 *  shapes in use — top-level `{ tenantId, workspaceId }` (enrichment/scoring/dedup/firmographics/outreach) and
 *  nested `{ scope: { tenantId, workspaceId } }` (master-backfill/reverification). Payloads with neither
 *  (dsar) yield nulls — the original job in the BullMQ failed set remains the lookup path for those. */
export function extractScope(data: unknown): {
  tenantId: string | null;
  workspaceId: string | null;
} {
  if (typeof data !== "object" || data === null) return { tenantId: null, workspaceId: null };
  const top = data as Record<string, unknown>;
  const source =
    typeof top.scope === "object" && top.scope !== null
      ? (top.scope as Record<string, unknown>)
      : top;
  return {
    tenantId: typeof source.tenantId === "string" ? source.tenantId : null,
    workspaceId: typeof source.workspaceId === "string" ? source.workspaceId : null,
  };
}

/** BullMQ's terminal stall failure (a job reclaimed more than maxStalledCount times — the worker process
 *  died repeatedly mid-job). It bypasses the attempts/backoff machinery, so attemptsMade can be below the
 *  budget when it fires; without this match a stall-exhausted job would silently skip the DLQ (plan 15 §3,
 *  stalled/lock tuning). Message text per bullmq's scripts (v5): "job stalled more than allowable limit". */
const STALL_EXHAUSTED = /stalled more than/i;

/** Build the dead-letter record for an exhausted job, or null while retries remain (mirrors
 *  deadLetterFailedImport's guard: in the `failed` event attemptsMade already counts the attempt that just
 *  failed, and an options-less job has a budget of exactly 1). Stall-exhausted failures are terminal
 *  regardless of remaining attempts, so they are dead-lettered immediately. */
export function buildDeadLetter(
  queueName: string,
  job: Pick<Job, "id" | "name" | "data" | "opts" | "attemptsMade">,
  err: Error,
): WorkerDeadLetter | null {
  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < maxAttempts && !STALL_EXHAUSTED.test(err.message)) {
    return null; // retries remain — not dead yet
  }
  const { tenantId, workspaceId } = extractScope(job.data);
  return {
    queue: queueName,
    originalJobId: String(job.id),
    jobName: job.name,
    failedReason: err.message,
    attemptsMade: job.attemptsMade,
    tenantId,
    workspaceId,
  };
}

/** Make an `on("failed")` listener that dead-letters exhausted jobs onto `deadLetterQueue`. Best-effort by
 *  design (mirrors register.ts's imports wiring): a routing failure is logged and swallowed — it must never
 *  throw inside the worker's event loop, and the original job still sits in the BullMQ failed set. */
export function makeDeadLetterHandler<T>(
  queueName: string,
  deadLetterQueue: Queue<WorkerDeadLetter>,
): (job: Job<T> | undefined, err: Error) => void {
  return (job, err) => {
    if (!job) return;
    const record = buildDeadLetter(queueName, job, err);
    if (!record) return;
    void deadLetterQueue.add("dead-letter", record).catch((e) =>
      log.error("dead-letter routing failed", {
        queue: queueName,
        jobId: job.id,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  };
}
