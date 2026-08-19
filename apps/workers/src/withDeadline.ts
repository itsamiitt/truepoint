// withDeadline.ts — processor-level deadline wrapper (worker-platform plan 15 §3.1). With concurrency 1 a
// single hung upstream call (an enrichment vendor read with no timeout, a wedged connection) held the job
// lock forever — BullMQ auto-renews locks for live jobs, so nothing behind it ever ran. Racing the WHOLE
// processor against a bound turns a hang into a normal attempt failure that enters the Phase-0 retry→DLQ
// path, and the queue keeps draining. Coarser than per-vendor-call aborts (those come with circuit
// breakers); the per-queue bounds live in tuning.ts PROCESSOR_DEADLINE_MS.
//
// CANCELLATION (perf-audit P1.2): JS promises can't be killed, so the deadline additionally ABORTS an
// AbortSignal handed to the processor. A signal-aware consumer (reverification) checks it between units of
// work and stops within one in-flight wave — writing its partial tally and checkpoint on the way out —
// instead of orphan-running (and orphan-SPENDING against vendors) to the end of its scan while the retry
// re-does the same work. A consumer that ignores the signal behaves exactly as before: the attempt fails at
// the deadline and the orphan runs on, contained by idempotency (and for outreach by the attempts=2
// double-send bound in retryPolicies.ts).

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

/** Wrap a processor so it fails (retryably) if it exceeds `deadlineMs`, aborting the signal so a
 *  cooperative processor can stop its orphaned work. The timer is cleared on settle. */
export function withDeadline<TData, TResult>(
  queue: string,
  deadlineMs: number,
  processor: (job: Job<TData>, signal: AbortSignal) => Promise<TResult>,
): (job: Job<TData>) => Promise<TResult> {
  return async (job) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        processor(job, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const err = new ProcessorDeadlineError(queue, deadlineMs);
            controller.abort(err);
            reject(err);
          }, deadlineMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
