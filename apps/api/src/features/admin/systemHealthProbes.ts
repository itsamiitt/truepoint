// systemHealthProbes.ts — the live BullMQ probe aggregator behind GET /admin/system-health (plan B2). The api
// owns the three queue PRODUCER singletons, so it can read their REAL depth/DLQ + connected-worker counts off
// Redis directly (CLIENT LIST via getWorkers) instead of inferring them from a DB tally. Each per-queue
// accessor is bounded by its own ~1.5s timeout and THROWS on timeout/Redis error; here we fan them out with
// Promise.allSettled so one dead queue never sinks the others and the whole probe is non-blocking + total —
// it always resolves, never rejects, so the route can never hang or 500 on it. We do NOT fabricate green
// checks: a queue that fails to answer is reported reachable:false with null counts (not a zeroed reading),
// and worker/redis status is derived only from queues that actually answered.

import { BULK_IMPORTS_QUEUE, IMPORTS_QUEUE, REVERIFICATION_QUEUE } from "@leadwolf/types";
import { reverificationQueueHealth } from "../home/reverificationQueue.ts";
import { bulkQueueHealth } from "../import/bulkQueue.ts";
import { importQueueHealth } from "../import/queue.ts";

/** Per-queue live reading. Counts are null (NOT 0) when the queue was unreachable — an honest "unknown",
 *  never a fabricated empty queue. Consumers must check `reachable` before trusting the numbers. */
export type QueueReport = {
  name: string;
  waiting: number | null;
  active: number | null;
  failed: number | null;
  delayed: number | null;
  workers: number | null;
  reachable: boolean;
};

export type SystemHealthProbe = {
  /** "up" if ≥1 queue answered (Redis reachable); "down" if every probe failed (Redis unreachable). */
  redis: "up" | "down";
  /** "up" if ANY reachable queue has ≥1 connected worker; "down" if reachable queues all report 0 workers;
   *  "unknown" if NO queue was reachable (Redis down → we genuinely cannot tell). */
  workers: "up" | "down" | "unknown";
  queues: QueueReport[];
};

/**
 * Derive the redis + workers service statuses from the per-queue probe results — PURE, so the threshold
 * logic is unit-testable in isolation (probeQueues just does the I/O fan-out, then calls this). redis is
 * "up" iff ≥1 queue answered (Redis reachable); workers is "unknown" when NO queue was reachable (Redis
 * down → we genuinely cannot tell), else "up" iff ANY reachable queue has ≥1 connected worker (any-queue,
 * NOT a sum — one worker process serving several queues must not read as "many"), else "down".
 */
export function deriveServiceHealth(queues: QueueReport[]): {
  redis: "up" | "down";
  workers: "up" | "down" | "unknown";
} {
  const anyReachable = queues.some((q) => q.reachable);
  if (!anyReachable) return { redis: "down", workers: "unknown" };
  const workers = queues.some((q) => q.reachable && (q.workers ?? 0) >= 1) ? "up" : "down";
  return { redis: "up", workers };
}

// Pair each accessor with its known queue name so an unreachable (rejected) probe can still be named.
const SPECS = [
  { name: IMPORTS_QUEUE, probe: importQueueHealth },
  { name: BULK_IMPORTS_QUEUE, probe: bulkQueueHealth },
  { name: REVERIFICATION_QUEUE, probe: reverificationQueueHealth },
] as const;

/** Fan out the three bounded queue probes and derive redis/workers/per-queue health. Always resolves
 *  (allSettled): a total Redis outage yields redis:"down", workers:"unknown", and every queue reachable:false
 *  — no throw, no hang. Worker liveness uses ANY-queue-has-a-worker, not a SUM, so one worker process serving
 *  several queues is not double-counted into a false "many workers" signal. */
export async function probeQueues(): Promise<SystemHealthProbe> {
  const settled = await Promise.allSettled(SPECS.map((s) => s.probe()));

  const queues: QueueReport[] = settled.map((r, i) =>
    r.status === "fulfilled"
      ? { ...r.value, reachable: true }
      : {
          name: SPECS[i]!.name,
          waiting: null,
          active: null,
          failed: null,
          delayed: null,
          workers: null,
          reachable: false,
        },
  );

  const { redis, workers } = deriveServiceHealth(queues);
  return { redis, workers, queues };
}
