// health.ts — a tiny Bun.serve liveness/readiness endpoint for the workers process so the container
// orchestrator (docker-compose healthcheck) can probe it. GET /health = liveness (the process is up);
// GET /ready = readiness (workers booted, not draining, AND — when a probe is wired — Redis reachable).
// No new dependency — Bun.serve is built in.
//
// The Redis probe exists because the shared IORedis runs with maxRetriesPerRequest: null (register.ts): a
// wedged Redis makes ioredis reconnect forever and BUFFER commands silently — the worker blocks but, before
// this probe, /ready still answered 200 (worker-platform plan 15 §2.2 item 0.3). The probe is bounded by its
// provider (a PING raced against a timeout) and gated by a CONSECUTIVE-failure threshold (re-audit F14): a
// single transient blip must not flip every replica to 503 at once and cascade into a fleet-wide restart storm.

/** Port the workers health endpoint listens on. A constant (not process.env) to honor the
 *  "no process.env outside @leadwolf/config" rule; promote to @leadwolf/config if it must be tunable. */
export const WORKERS_HEALTH_PORT = 3002;

/** A bounded, never-throwing reachability check (register.ts's redisReadinessProbe). Must resolve false —
 *  not hang — when the dependency is wedged; the caller owns the timeout. */
export type ReadinessProbe = () => Promise<boolean>;

/** Consecutive probe failures before /ready flips to 503 (F14: threshold, not first-failure). With the
 *  compose healthcheck probing every 10s, 3 consecutive failures ≈ 30s of sustained Redis outage. */
export const DEFAULT_PROBE_FAILURE_THRESHOLD = 3;

/** Renders the Prometheus text exposition for GET /metrics (register.ts's collectWorkerMetricsText). */
export type MetricsTextProvider = () => Promise<string>;

/** Start the health server. `isReady` is polled per /ready request so it reflects live drain state; `probe`
 *  (optional) is additionally consulted per /ready request with the consecutive-failure threshold above;
 *  `metricsText` (optional, Phase 4) serves GET /metrics in Prometheus text format — a failing collection
 *  answers 503 and never affects /health or /ready. */
export function startHealthServer(
  isReady: () => boolean,
  port: number = WORKERS_HEALTH_PORT,
  probe?: ReadinessProbe,
  failureThreshold: number = DEFAULT_PROBE_FAILURE_THRESHOLD,
  metricsText?: MetricsTextProvider,
) {
  let consecutiveProbeFailures = 0;
  return Bun.serve({
    port,
    async fetch(req): Promise<Response> {
      const { pathname } = new URL(req.url);
      if (pathname === "/health") return new Response("ok", { status: 200 });
      if (pathname === "/metrics" && metricsText) {
        try {
          return new Response(await metricsText(), {
            status: 200,
            headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
          });
        } catch {
          return new Response("metrics collection failed", { status: 503 });
        }
      }
      if (pathname === "/ready") {
        if (!isReady()) return new Response("draining", { status: 503 });
        if (probe) {
          // A throwing probe counts as a failure, never a crash.
          const ok = await probe().catch(() => false);
          consecutiveProbeFailures = ok ? 0 : consecutiveProbeFailures + 1;
          if (consecutiveProbeFailures >= failureThreshold) {
            return new Response("redis unreachable", { status: 503 });
          }
        }
        return new Response("ready", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
}
