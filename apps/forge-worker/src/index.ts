// @leadwolf/forge-worker entry — boot the DAG worker fleet with a liveness/metrics health server + a bounded
// SIGTERM/SIGINT drain (mirrors apps/workers). On shutdown each Worker stops accepting new jobs and finishes
// in-flight ones within DRAIN_TIMEOUT_MS, then force-closes — safe because every processor is idempotent.
import { renderPrometheus } from "@leadwolf/forge-core";
import type { Worker } from "bullmq";
import { startWorkers } from "./register.ts";

const DRAIN_TIMEOUT_MS = 30_000;
const HEALTH_PORT = Number(process.env.FORGE_WORKER_HEALTH_PORT ?? 3006);

const started = startWorkers();
console.info(
  `forge-worker online — ${started.workers.length} consumers over ${started.queues.join(", ")} (${started.env})`,
);

let shuttingDown = false;

Bun.serve({
  port: HEALTH_PORT,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/ready") {
      return Response.json({ ready: !shuttingDown }, { status: shuttingDown ? 503 : 200 });
    }
    if (path === "/metrics") {
      return new Response(
        renderPrometheus([
          { name: "forge_workers_up", value: shuttingDown ? 0 : 1 },
          { name: "forge_worker_count", value: started.workers.length },
        ]),
      );
    }
    return new Response("ok");
  },
});

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(
    `[shutdown] ${signal} — draining ${started.workers.length} workers (≤${DRAIN_TIMEOUT_MS}ms)`,
  );
  await Promise.all(
    started.workers.map(async (w: Worker) => {
      try {
        await Promise.race([
          w.close(),
          new Promise((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS)),
        ]);
      } catch {
        await w.close(true);
      }
    }),
  );
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
