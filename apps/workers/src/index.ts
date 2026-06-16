// index.ts — the workers process entry. Boots every queue consumer, exposes a liveness/readiness health
// endpoint for the orchestrator, and drains in-flight jobs on SIGINT/SIGTERM before exit. Run with
// `bun run dev` (against the docker-compose Redis).

import { startHealthServer } from "./health.ts";
import { log } from "./logger.ts";
import { startWorkers } from "./register.ts";

const workers = startWorkers();
let ready = true;
const health = startHealthServer(() => ready);
log.info("workers: started", { processors: workers.length, healthPort: health.port });

let draining = false;
async function shutdown(signal: string): Promise<void> {
  if (draining) return; // ignore repeated signals while a drain is already in flight
  draining = true;
  ready = false; // fail readiness so the orchestrator stops considering us live while we drain
  log.info("workers: draining", { signal });
  await Promise.all(workers.map((w) => w.close()));
  await health.stop(true);
  log.info("workers: drained, exiting");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
