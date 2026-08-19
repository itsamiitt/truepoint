// tracedQueue.ts — a Queue that stamps the active trace context onto every job it enqueues (E-6.5).
//
// This is the producer half of the propagation the consumer side already reads. Without it a worker span is
// its own trace: correct in isolation, useless for answering "which request caused this job".
//
// A Queue subclass rather than ~50 edited call sites. `.add()` is called from dozens of places across two
// apps with varying argument shapes, so intercepting the one method is both smaller and impossible to forget
// at a new call site — the failure mode of per-site injection is a job that quietly starts its own trace.
//
// SAFETY: this adds a key to every job payload. Every consumer schema is a plain `z.object()`, which STRIPS
// unknown keys rather than rejecting them (none are `.strict()`), and `tracedWorker` reads the carrier off the
// RAW job before any parsing — so processors see exactly the payload shape they always did.

import { injectTraceContext } from "@leadwolf/config";
import { Queue, type QueueOptions } from "bullmq";

/** The key the carrier is stamped under. Must match tracedWorker's. */
export const TRACE_CARRIER_KEY = "__trace";

class TracedQueue<T> extends Queue<T> {
  // Spread the INHERITED parameter tuple rather than restating it: BullMQ layers several conditional
  // generics over add(), and a hand-written signature drifts from the base the moment any of them changes.
  override add(...args: Parameters<Queue<T>["add"]>): ReturnType<Queue<T>["add"]> {
    const [name, data, opts] = args;
    const carrier = injectTraceContext();
    // Empty when nothing is recording, so an untraced process enqueues exactly the payload it always did.
    if (Object.keys(carrier).length === 0 || !data || typeof data !== "object") {
      return super.add(...args);
    }
    // Through `unknown`: the carrier is deliberately NOT part of the job's declared data type — it is
    // transport that tracedWorker strips off the raw job, and the consumer's schema drops it on parse.
    const payload = { ...(data as object), [TRACE_CARRIER_KEY]: carrier } as unknown as typeof data;
    return super.add(name, payload, opts);
  }
}

/**
 * Retention every worker-root queue gets unless its construction or a specific `.add()` says otherwise.
 * BullMQ's default is keep-EVERYTHING-forever, and none of the ~24 queues built here passed options, so every
 * completed tick and failed job accumulated as a permanent Redis hash (~5.5k/day from the minute-ticks alone
 * before any real traffic) — unbounded Redis growth that also slowed every getJobCounts scrape (perf-audit RC8).
 * Completed jobs are kept briefly for inspection; failed jobs a week (where a queue has a DLQ, the DLQ copy is
 * the durable evidence — buildDeadLetter writes it on final failure). Explicit opts still win: queue-level
 * defaultJobOptions passed by a caller override these, and per-job options passed to `.add()` override both,
 * so a queue that deliberately keeps failures forever (e.g. compliance lanes) keeps doing so by saying so.
 * apps/api's producers and apps/forge-worker already set their own retention; this closes the worker root.
 */
export const WORKER_DEFAULT_JOB_OPTIONS = {
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

/** Construct a Queue that propagates trace context. Drop-in for `new Queue<T>(name, opts)`, plus the bounded
 *  retention defaults above (overridable per queue and per job). */
export function tracedQueue<T>(name: string, opts: QueueOptions): Queue<T> {
  return new TracedQueue<T>(name, {
    ...opts,
    defaultJobOptions: { ...WORKER_DEFAULT_JOB_OPTIONS, ...opts.defaultJobOptions },
  });
}
