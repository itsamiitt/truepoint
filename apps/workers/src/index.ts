// index.ts — the workers process entry. Boots every queue consumer, exposes a liveness/readiness health
// endpoint for the orchestrator, and drains in-flight jobs on SIGINT/SIGTERM before exit. Run with
// `bun run dev` (against the docker-compose Redis).

import { envSurfaceReport } from "@leadwolf/config";
import { WORKERS_HEALTH_PORT, startHealthServer } from "./health.ts";
import { log } from "./logger.ts";
import {
  collectWorkerMetricsText,
  redisReadinessProbe,
  startWorkers,
  stopBackgroundRelays,
} from "./register.ts";

const workers = startWorkers();
let ready = true;
// /ready = booted AND not draining AND (0.3/F14) Redis reachable — via the bounded PING with a
// consecutive-failure threshold, so a wedged Redis fails readiness but a blip doesn't flap the fleet.
// /metrics (Phase 4) serves the zero-dep Prometheus text: per-queue counters + depths + outbox relay lag.
const health = startHealthServer(
  () => ready,
  WORKERS_HEALTH_PORT,
  redisReadinessProbe,
  undefined, // failure threshold: keep the F14 default
  collectWorkerMetricsText,
);
// Boot self-test (plan 15 §4.1): make "did the worker boot, and with what env surface?" answerable at a
// glance. relaxedMissing lists web/auth-only keys absent under LEADWOLF_SURFACE=worker (access-guarded).
log.info("workers: started", {
  processors: workers.length,
  healthPort: health.port,
  envSurface: envSurfaceReport.surface,
  relaxedMissing: envSurfaceReport.relaxedMissing,
});

/** Bound the graceful drain (plan 15 §3.1): with a hung job the un-bounded close() waited forever, so
 *  SIGTERM hung until the orchestrator SIGKILLed us. 30s comfortably exceeds a healthy in-flight job's
 *  remaining work; a genuinely hung one is force-closed and reclaimed by another worker via the stall
 *  machinery (lockDuration/stalledInterval in tuning.ts). */
const DRAIN_TIMEOUT_MS = 30_000;

let draining = false;
async function shutdown(signal: string): Promise<void> {
  if (draining) return; // ignore repeated signals while a drain is already in flight
  draining = true;
  ready = false; // fail readiness so the orchestrator stops considering us live while we drain
  log.info("workers: draining", { signal });
  // Stop the outbox relay FIRST (Phase 3): no new drive publish may race the worker close below; unclaimed
  // intents stay pending in worker_outbox and the next boot's relay resumes them (at-least-once).
  await stopBackgroundRelays().catch(() => {});
  const drained = await Promise.race([
    Promise.all(workers.map((w) => w.close())).then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS)),
  ]);
  if (!drained) {
    log.error("workers: drain timed out, forcing close", { timeoutMs: DRAIN_TIMEOUT_MS });
    // close(true) abandons in-flight jobs; their locks expire and the stall machinery reclaims them.
    await Promise.all(workers.map((w) => w.close(true))).catch(() => {});
  }
  await health.stop(true);
  log.info("workers: drained, exiting");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
