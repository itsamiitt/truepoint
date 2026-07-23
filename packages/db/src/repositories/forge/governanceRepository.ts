// governanceRepository — review-queue writes (Phase 5). The verify processor enqueues a human review task
// (four-eyes: the worker NEVER self-approves; a human approves via the promotion API → promoteVerifiedRecord).
// Idempotent (P-01.16): a partial unique index enforces at-most-one OPEN task per (subject_ref, task_type), so a
// redelivered/retried verify job converges via ON CONFLICT DO NOTHING instead of duplicating the task.
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../../client.ts";
import { approvalRequests, quarantine, reviewTasks } from "../../schema/forge.ts";

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

// Persist the verify stage's promotion approval-request (P-01.10 producer) — the SERVER-authoritative maker +
// candidate that the four-eyes approve path later loads (never the client body). Idempotent on
// (op_class, subject_ref) among PENDING rows, so a redelivered verify converges; returns the (new or existing) id.
export async function insertApprovalRequest(
  tx: Tx,
  input: { opClass: string; requestedByUserId: string; subjectRef: string; payload: unknown },
): Promise<string> {
  const inserted = await tx
    .insert(approvalRequests)
    .values({
      opClass: input.opClass,
      requestedByUserId: input.requestedByUserId,
      subjectRef: input.subjectRef,
      payload: input.payload,
    })
    .onConflictDoNothing({
      target: [approvalRequests.opClass, approvalRequests.subjectRef],
      where: sql`${approvalRequests.status} = 'pending'`,
    })
    .returning({ id: approvalRequests.id });
  if (inserted[0]) return inserted[0].id;
  // Lost the race / already pending — return the existing request's id so the review task links to it.
  const [existing] = await tx
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.opClass, input.opClass),
        eq(approvalRequests.subjectRef, input.subjectRef),
        eq(approvalRequests.status, "pending"),
      ),
    )
    .limit(1);
  return existing?.id ?? "";
}
