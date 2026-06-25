// sequenceScheduler.ts — the leader-locked sequence tick (M12 P4, email-planning/13 P4, 15 §A.4). One tick
// CLAIMS a bounded batch of due enrollments (schedulerRepository.claimDueEnrollments — FOR UPDATE SKIP LOCKED
// so two ticks never claim the same row) and hands each to `enqueue` (the worker passes enqueueOutreach,
// which advances the enrollment's next step through the UNCHANGED M9 send path, D11). `enqueue` is INJECTED so
// the tick is unit/itest-testable without BullMQ. A replied/bounced/paused enrollment is never claimed
// (auto-pause-on-reply lives in the claim's WHERE). The leader lock + repeat live in the worker; this is the
// pure, deterministic body.

import { type ClaimedEnrollment, schedulerRepository } from "@leadwolf/db";

export interface TickResult {
  claimed: number;
  enqueued: number;
}

export interface TickOptions {
  /** Max enrollments to advance per tick (the FOR UPDATE SKIP LOCKED LIMIT — bounds fan-out, 15 §A.8). */
  batchSize?: number;
  /** Hand a claimed enrollment to the send path (the worker passes enqueueOutreach). */
  enqueue: (e: ClaimedEnrollment) => Promise<void>;
}

export async function tickSequences(opts: TickOptions): Promise<TickResult> {
  const claimed = await schedulerRepository.claimDueEnrollments(opts.batchSize ?? 200);
  let enqueued = 0;
  for (const e of claimed) {
    try {
      await opts.enqueue(e);
      enqueued += 1;
    } catch {
      // A failed enqueue is not fatal: the claim already reserved the row (bumped last_event_at), so it
      // becomes due again after the step delay and is retried on a later tick. Never throws the whole tick.
    }
  }
  return { claimed: claimed.length, enqueued };
}
