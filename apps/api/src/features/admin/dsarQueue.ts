// dsarQueue.ts — the `dsar` queue PRODUCER for the staff workflow (06-roadmap Phase 5 "DSAR workflow
// automation"). Sibling of reveal/bulkRevealQueue.ts: producer and consumer share only the queue NAME
// (DSAR_QUEUE, @leadwolf/types) and the Redis URL, never each other's code (apps-never-import-apps).
//
// WHY THIS EXISTS AT ALL. The intake route, the queue, the worker and the whole privileged fan-out were
// already built — and nothing connected them. `enqueueDsar` in apps/workers had zero callers, so a subject
// could file an erasure request, staff could move it through the workflow, and the erasure never ran. The
// gap was invisible because every individual piece worked and the admin UI showed a status changing.
//
// DISPATCHED FROM THE STAFF TRANSITION, NOT FROM INTAKE. The obvious wiring — enqueue when the public form
// is submitted — is the dangerous one: the intake endpoint is deliberately session-less, so self-dispatch
// would let anyone erase anyone by typing their address. The `verifying` status and the verified_at column
// exist precisely because identity has to be established first. Staff moving a request to `processing` IS
// that assertion, so that is where the job belongs.

import { env } from "@leadwolf/config";
import { DSAR_QUEUE } from "@leadwolf/types";
import type { Queue } from "bullmq";
import IORedis from "ioredis";
import { tracedQueue } from "../../lib/tracedQueue.ts";

/**
 * The payload: an id and a discriminator, never the subject's email. The fan-out reads the blind index from
 * the request row, so the address of the person being erased never enters Redis — see DsarJobData in
 * apps/workers/src/queues/dsar.ts.
 */
export interface DsarQueueJob {
  requestId: string;
  requestType: "access" | "delete";
}

// Lazily opened so importing this module never dials Redis.
let queue: Queue<DsarQueueJob> | undefined;
function dsarQueue(): Queue<DsarQueueJob> {
  if (!queue) {
    const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = tracedQueue<DsarQueueJob>(DSAR_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000, jitter: 0.5 },
        // Kept, not swept: a completed erasure is evidence. removeOnFail was already false for the same
        // reason — a DSAR that failed silently and vanished from the queue is the worst outcome available.
        removeOnComplete: false,
        removeOnFail: false,
      },
    });
  }
  return queue;
}

/**
 * Dispatch a verified DSAR for privileged processing.
 *
 * `rectify` is deliberately not dispatchable: the enum accepts it at intake but no processing path exists, so
 * enqueueing one would produce a job that can only fail. Staff handle those manually until Phase 5's
 * correction flow lands — and the caller reports what happened rather than pretending a job was queued.
 */
export async function enqueueDsar(job: DsarQueueJob): Promise<string> {
  const queued = await dsarQueue().add("dsar", job);
  return String(queued.id);
}
