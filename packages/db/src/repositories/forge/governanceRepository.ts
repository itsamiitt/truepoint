// governanceRepository — review-queue writes (Phase 5). The verify processor enqueues a human review task
// (four-eyes: the worker NEVER self-approves; a human approves via the promotion API → promoteVerifiedRecord).
// Idempotent (P-01.16): a partial unique index enforces at-most-one OPEN task per (subject_ref, task_type), so a
// redelivered/retried verify job converges via ON CONFLICT DO NOTHING instead of duplicating the task.
import { sql } from "drizzle-orm";
import type { Tx } from "../../client.ts";
import { quarantine, reviewTasks } from "../../schema/forge.ts";

export async function insertReviewTask(
  tx: Tx,
  input: { taskType: string; subjectRef: string; confidence?: number; priority?: number },
): Promise<void> {
  await tx
    .insert(reviewTasks)
    .values({
      taskType: input.taskType,
      subjectRef: input.subjectRef,
      confidence: input.confidence != null ? String(input.confidence) : null,
      priority: input.priority ?? 0,
    })
    .onConflictDoNothing({
      target: [reviewTasks.subjectRef, reviewTasks.taskType],
      where: sql`${reviewTasks.status} = 'open'`,
    });
}

// Persist a drifted/unparseable capture (P-01.8). Idempotent on (raw_capture_id, route): a re-quarantine of the
// same capture+route refreshes the reason rather than piling up rows, so redelivered parse jobs converge.
export async function insertQuarantine(
  tx: Tx,
  input: { rawCaptureId: string; route: string; reason: string },
): Promise<void> {
  await tx
    .insert(quarantine)
    .values({ rawCaptureId: input.rawCaptureId, route: input.route, reason: input.reason })
    .onConflictDoUpdate({
      target: [quarantine.rawCaptureId, quarantine.route],
      set: { reason: input.reason, updatedAt: new Date() },
    });
}
