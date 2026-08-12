// The Hono app. Composition only — no business logic, no SQL.
// Contract: cascade-graph/api/openapi.yaml.

import type { DbClient } from "@cascade/db";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ApiProblem, problemResponse, unauthorized } from "./problem";
import { organizationRoutes, personRoutes } from "./routes/organizations";
import { evidenceRoutes, metaRoutes, technologyRoutes } from "./routes/technologies";

export interface AppDeps {
  db: DbClient;
  /** When set, every /v1 route requires this Bearer token. Unset = open (dev/test). */
  apiKey?: string;
}

type Env = { Variables: { db: DbClient } };

export function createApp(deps: AppDeps) {
  const app = new Hono<Env>();

  app.use("*", cors({ origin: "*", maxAge: 7200 }));

  app.use("*", async (c, next) => {
    c.set("db", deps.db);
    await next();
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  // Auth on every /v1 route (08 §2). Public routes are enumerated above this line.
  app.use("/v1/*", async (c, next) => {
    if (deps.apiKey) {
      const header = c.req.header("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (token !== deps.apiKey) throw unauthorized();
    }
    await next();
  });

  app.route("/v1/organizations", organizationRoutes);
  app.route("/v1/people", personRoutes);
  app.route("/v1/technologies", technologyRoutes);
  app.route("/v1/evidence", evidenceRoutes);
  app.route("/v1", metaRoutes);

  // One error shape, including for unmatched routes (Crustdata drifts here; we don't).
  app.notFound((c) =>
    problemResponse(
      c,
      new ApiProblem({ status: 404, code: "route_not_found", title: "No such endpoint." }),
    ),
  );

  app.onError((err, c) => {
    if (err instanceof ApiProblem) return problemResponse(c, err);
    console.error({
      msg: "unhandled_error",
      path: c.req.path,
      method: c.req.method,
      err: String(err),
    });
    return problemResponse(
      c,
      new ApiProblem({ status: 500, code: "internal_error", title: "Something went wrong." }),
    );
  });

  return app;
}
