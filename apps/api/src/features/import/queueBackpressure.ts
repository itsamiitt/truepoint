// queueBackpressure.ts — producer-side backpressure for the import queues (worker-platform plan 15 §7 —
// Phase 5 subset; doc 18 §9). Without autoscaling, an unbounded intake lets a backlog cascade into Redis
// memory pressure and blown freshness SLOs; shedding at the door with a typed 503 keeps the system degrading
// gracefully instead ("shed/slow producers"). The depth read is bounded (~500ms) and FAILS OPEN: when the
// signal is unreachable, availability beats shedding on an unknown — the enqueue itself will surface a real
// Redis outage. The 503 carries retryAfterSeconds as an RFC 9457 extension member for client backoff.

import { AppError } from "@leadwolf/types";
import type { Queue } from "bullmq";

const DEPTH_READ_TIMEOUT_MS = 500;
const RETRY_AFTER_SECONDS = 60;

/**
 * Throw a typed 503 when `queue` already has ≥ maxWaiting jobs waiting. Call before enqueueing.
 * Fail-open on an unreadable depth (see header).
 */
export async function assertQueueCapacity(
  queue: Pick<Queue, "getJobCounts">,
  queueName: string,
  maxWaiting: number,
): Promise<void> {
  let waiting: number;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const counts = await Promise.race([
      queue.getJobCounts("waiting"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("depth read timed out")), DEPTH_READ_TIMEOUT_MS);
      }),
    ]);
    waiting = counts.waiting ?? 0;
  } catch {
    return; // fail open — an unknown depth must not shed real work
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (waiting >= maxWaiting) {
    throw new AppError({
      status: 503,
      code: "queue_backpressure",
      title: "Import queue is saturated",
      detail: `The ${queueName} queue has ${waiting} jobs waiting (limit ${maxWaiting}); retry shortly.`,
      extensions: { retryAfterSeconds: RETRY_AFTER_SECONDS },
    });
  }
}
