// @leadwolf/forge-api — the Hono app (03 §The four services): capture-ingest edge + dashboard BFF + review.
// Never imports the AI extraction adapters (extraction/provider calls are worker-side, 04). Assembled as a
// factory so the composition root (server.ts) injects real deps and tests inject fakes.
import { clientIpFromHeaders } from "@leadwolf/auth";
import { renderPrometheus } from "@leadwolf/forge-core";
import { Hono } from "hono";
import { type CapturesDeps, createCapturesApp } from "./features/captures/routes.ts";
import { type BffDeps, createBffApp } from "./features/dashboard-bff/routes.ts";
import { type ReviewDeps, createReviewApp } from "./features/review/routes.ts";
import { notFound, onError } from "./middleware/error.ts";

/** Ops endpoints, exempt from the throttle: the orchestrator polls /ready and /live on a fixed interval and a
 *  scraper polls /metrics, so throttling them would make the limiter fight the platform's own health checks. */
const OPS_PATHS: ReadonlySet<string> = new Set(["/ready", "/live", "/metrics"]);

export function createForgeApi(deps: {
  captures: CapturesDeps;
  bff: BffDeps;
  review: ReviewDeps;
  /** Coarse per-caller throttle, injected (server.ts passes checkRequestRate). Omitted in tests so they never
   *  construct a Redis client. Previously this app had NO global limit at all: apps/api throttles /api/*, but
   *  forge-api applied nothing, leaving every unbounded /bff/* read and the review/approve promotion write
   *  wide open — and the capture route's own limiter was keyed on client-declared byte counts. */
  rateLimit?: (key: string) => Promise<void>;
  /** Shared-secret gate for /metrics, injected (server.ts passes env.METRICS_TOKEN). When absent the endpoint
   *  404s, matching apps/api: a scraper has no user JWT, so the secret IS the gate, and a wrong/missing token
   *  404s rather than 401s so the endpoint is invisible to anyone without it. It was previously served
   *  unauthenticated on the PUBLIC forge-api.truepoint.in origin. */
  metricsToken?: string;
}): Hono {
  const app = new Hono();
  app.notFound(notFound);
  app.onError(onError);

  // Throttle first, so it also covers a request that later 404s or throws.
  const throttle = deps.rateLimit;
  if (throttle) {
    app.use("*", async (c, next) => {
      if (!OPS_PATHS.has(new URL(c.req.url).pathname)) {
        // Keyed by client IP: this runs BEFORE the per-route auth resolvers, so no verified subject exists yet.
        // Coarse by design — the per-subject limits live on the routes that have already authenticated. The
        // "forge:" prefix keeps this in its own keyspace so it never shares a bucket with the main API.
        await throttle(`forge:ip:${clientIpFromHeaders({ get: (n) => c.req.header(n) ?? null })}`);
      }
      await next();
    });
  }

  app.get("/ready", (c) => c.json({ ready: true }));
  app.get("/live", (c) => c.json({ live: true }));
  // Prometheus exposition (P7/15). Real queue/pipeline gauges are scraped where infra exists.
  app.get("/metrics", (c) => {
    if (!deps.metricsToken || c.req.header("authorization") !== `Bearer ${deps.metricsToken}`) {
      return c.notFound();
    }
    return c.text(renderPrometheus([{ name: "forge_api_up", value: 1 }]));
  });
  app.route("/", createCapturesApp(deps.captures));
  app.route("/", createBffApp(deps.bff));
  app.route("/", createReviewApp(deps.review));
  return app;
}
