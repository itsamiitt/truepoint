// health.ts — a tiny Bun.serve liveness/readiness endpoint for the workers process so the container
// orchestrator (docker-compose healthcheck) can probe it. GET /health = liveness (the process is up);
// GET /ready = readiness (workers booted and not draining). No new dependency — Bun.serve is built in.

/** Port the workers health endpoint listens on. A constant (not process.env) to honor the
 *  "no process.env outside @leadwolf/config" rule; promote to @leadwolf/config if it must be tunable. */
export const WORKERS_HEALTH_PORT = 3002;

/** Start the health server. `isReady` is polled per /ready request so it reflects live drain state. */
export function startHealthServer(isReady: () => boolean, port: number = WORKERS_HEALTH_PORT) {
  return Bun.serve({
    port,
    fetch(req): Response {
      const { pathname } = new URL(req.url);
      if (pathname === "/health") return new Response("ok", { status: 200 });
      if (pathname === "/ready") {
        return isReady()
          ? new Response("ready", { status: 200 })
          : new Response("draining", { status: 503 });
      }
      return new Response("not found", { status: 404 });
    },
  });
}
