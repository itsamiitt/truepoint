// governanceRepository — review-queue writes (Phase 5). The verify processor enqueues a human review task
// (four-eyes: the worker NEVER self-approves; a human approves via the promotion API → promoteVerifiedRecord).
import type { Tx } from "../../client.ts";
import { reviewTasks } from "../../schema/forge.ts";

export async function insertReviewTask(
  tx: Tx,
  input: { taskType: string; subjectRef: string; confidence?: number; priority?: number },
): Promise<void> {
  await tx.insert(reviewTasks).values({
    taskType: input.taskType,
    subjectRef: input.subjectRef,
    confidence: input.confidence != null ? String(input.confidence) : null,
    priority: input.priority ?? 0,
  });
}
