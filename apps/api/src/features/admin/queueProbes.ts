// queueProbes.ts — GENERIC bounded queue probes for the system-health surface (worker-platform plan 15 §6 —
// Phase 4). The three feature-owned accessors (imports / bulk-imports / reverification) probe their own lazy
// producer singletons; every OTHER queue the workers consume has no api-side producer, so this module owns
// one lazy read-only connection + cached Queue handles by NAME and probes them the same way: getJobCounts +
// getWorkers raced against a ~1.5s timeout, THROWING on timeout/Redis error so the caller's allSettled marks
// the queue unreachable (never a fabricated zeroed reading — the systemHealthProbes contract). Read-only:
// never enqueues; a DLQ's depth is its `waiting` count (nothing consumes a DLQ — records wait for redrive).

import { env } from "@leadwolf/config";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import type { QueueReport } from "./systemHealthProbes.ts";

const HEALTH_PROBE_TIMEOUT_MS = 1500;

// Lazily opened on first probe so merely importing this module never dials Redis (the import/queue.ts
// pattern). BullMQ requires maxRetriesPerRequest: null on its connection.
let connection: IORedis | undefined;
const handles = new Map<string, Queue>();

function queueHandle(name: string): Queue {
  let handle = handles.get(name);
  if (!handle) {
    connection ??= new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    handle = new Queue(name, { connection });
    handles.set(name, handle);
  }
  return handle;
}

/** Probe one queue by name — bounded, throwing on timeout/error (allSettled-friendly). */
export async function genericQueueHealth(name: string): Promise<Omit<QueueReport, "reachable">> {
  const q = queueHandle(name);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const [counts, workers] = await Promise.all([
          q.getJobCounts("waiting", "active", "failed", "delayed"),
          q.getWorkers(),
        ]);
        return {
          name,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          failed: counts.failed ?? 0,
          delayed: counts.delayed ?? 0,
          workers: workers.length,
        };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`queue probe timed out: ${name}`)),
          HEALTH_PROBE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
