// tracedWorker.ts — every BullMQ Worker, wrapped in a span (E-6.5).
//
// One helper rather than 35 hand-instrumented processors: `register.ts` constructs a Worker per queue and is
// the most collision-prone file in the repo, so the tracing has to be a single uniform substitution there
// (`new Worker<T>(...)` → `tracedWorker<T>(...)`) instead of 35 bespoke edits.
//
// The span wraps the processor from the OUTSIDE, which puts it around `withDeadline`'s race as well. That is
// deliberate: a job killed by its deadline should appear on the span as an error, and a span nested INSIDE
// the race would simply never end when the deadline won.
//
// Trace context is EXTRACTED from the job payload when a producer put it there, so a job enqueued during an
// API request continues that request's trace instead of starting an unrelated one. A job without it still
// gets a span — an untraced producer should not cost the worker its telemetry.

import { withExtractedSpan } from "@leadwolf/config";
import { type Job, type Processor, Worker, type WorkerOptions } from "bullmq";

/** The key a producer stamps the W3C trace carrier onto. Underscored so it reads as transport, not payload. */
export const TRACE_CARRIER_KEY = "__trace";

/** Job payloads may carry a trace carrier alongside their own fields. */
export type MaybeTraced = { [TRACE_CARRIER_KEY]?: Record<string, string> };

/**
 * Construct a Worker whose processor runs inside a span named `worker.job.<queue>`.
 *
 * The job id is recorded but the payload is NOT: job data routinely carries contact ids, emails and search
 * text, and a trace backend is a second copy of production data with its own retention and access rules
 * (truepoint-security data-protection).
 */
export function tracedWorker<T>(
  queue: string,
  processor: Processor<T>,
  opts: WorkerOptions,
): Worker<T> {
  const traced: Processor<T> = (job: Job<T>, token?: string) => {
    const carrier = (job.data as MaybeTraced | undefined)?.[TRACE_CARRIER_KEY];
    return withExtractedSpan(
      carrier,
      `worker.job.${queue}`,
      { "queue.name": queue, "job.id": job.id ?? "", "job.attempt": job.attemptsMade },
      async () => processor(job, token),
    );
  };
  return new Worker<T>(queue, traced, opts);
}
