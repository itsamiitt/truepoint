// @leadwolf/forge-api — the Hono app (03 §The four services): capture-ingest edge + dashboard BFF + review.
// Never imports the AI extraction adapters (extraction/provider calls are worker-side, 04). Assembled as a
// factory so the composition root (server.ts) injects real deps and tests inject fakes.
import { renderPrometheus } from "@leadwolf/forge-core";
import { Hono } from "hono";
import { type CapturesDeps, createCapturesApp } from "./features/captures/routes.ts";
import { type BffDeps, createBffApp } from "./features/dashboard-bff/routes.ts";
import { type ReviewDeps, createReviewApp } from "./features/review/routes.ts";

export function createForgeApi(deps: {
  captures: CapturesDeps;
  bff: BffDeps;
  review: ReviewDeps;
}): Hono {
  const app = new Hono();
  app.get("/ready", (c) => c.json({ ready: true }));
  app.get("/live", (c) => c.json({ live: true }));
  // Prometheus exposition (P7/15). Real queue/pipeline gauges are scraped where infra exists.
  app.get("/metrics", (c) => c.text(renderPrometheus([{ name: "forge_api_up", value: 1 }])));
  app.route("/", createCapturesApp(deps.captures));
  app.route("/", createBffApp(deps.bff));
  app.route("/", createReviewApp(deps.review));
  return app;
}
