// withDeadline.ts — processor-level deadline wrapper (worker-platform plan 15 §3.1). With concurrency 1 a
// single hung upstream call (an enrichment vendor read with no timeout, a wedged connection) held the job
// lock forever — BullMQ auto-renews locks for live jobs, so nothing behind it ever ran. Racing the WHOLE
// processor against a bound turns a hang into a normal attempt failure that enters the Phase-0 retry→DLQ
// path, and the queue keeps draining. Coarser than per-vendor-call aborts (those come with circuit
// breakers); the per-queue bounds live in tuning.ts PROCESSOR_DEADLINE_MS.
//
// CAVEAT (documented in tuning.ts too): the orphaned work keeps running past the deadline — JS promises
// aren't cancelled. That is safe here because every wrapped consumer is idempotent (a duplicate effect is a
// no-op re-run); for outreach the attempts=2 double-send bound in retryPolicies.ts is the containment.

import type { Job } from "bullmq";

/** A deadline expiry — a retryable failure like any thrown processor error: BullMQ applies the job's
 *  attempts/backoff budget and the dead-letter handler records exhaustion. */
export class ProcessorDeadlineError extends Error {
  constructor(queue: string, deadlineMs: number) {
    super(
      `${queue}: processor exceeded its ${deadlineMs}ms deadline; failing this attempt so retry/DLQ take over`,
    );
    this.name = "ProcessorDeadlineError";
  }
}

/** Wrap a processor so it fails (retryably) if it exceeds `deadlineMs`. The timer is cleared on settle. */
export function withDeadline<TData, TResult>(
  queue: string,
  deadlineMs: number,
  processor: (job: Job<TData>) => Promise<TResult>,
): (job: Job<TData>) => Promise<TResult> {
  return async (job) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        processor(job),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new ProcessorDeadlineError(queue, deadlineMs));
          }, deadlineMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
