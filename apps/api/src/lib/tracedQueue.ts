// tracedQueue.ts — a Queue that stamps the active trace context onto every job it enqueues (E-6.5).
//
// This is the producer half of the propagation the consumer side already reads. Without it a worker span is
// its own trace: correct in isolation, useless for answering "which request caused this job".
//
// A Queue subclass rather than edited call sites: intercepting the one method is impossible to forget at a
// new call site, where the failure mode of per-site injection is a job that quietly starts its own trace.
//
// This is a deliberate 30-line twin of apps/workers/src/tracedQueue.ts. The two apps cannot import each
// other, and hoisting it into a shared package would put a bullmq dependency into one that has no other
// reason to carry it. If either copy changes, change both — they must agree on TRACE_CARRIER_KEY above all.
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

/** Construct a Queue that propagates trace context. Drop-in for `new Queue<T>(name, opts)`. */
export function tracedQueue<T>(name: string, opts: QueueOptions): Queue<T> {
  return new TracedQueue<T>(name, opts);
}
