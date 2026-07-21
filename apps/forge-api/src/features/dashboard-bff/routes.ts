// dashboard-bff — the read BFF the operator console (apps/admin) talks to over fetchWithAuth (13, 03 §The four
// services). Every route is capability-gated server-side — the console renders, it does not decide. Read models
// come from injected readers (db repos in prod), so the BFF is unit-testable. The gate is applied INSIDE each
// handler (not chained Hono middleware) to keep the route types shallow.
import { type Context, Hono } from "hono";
import { type Capability, type ResolveStaff, hasCapability } from "../../middleware/capability.ts";

export interface BffReaders {
  overview: () => Promise<unknown>;
  reviewTasks: () => Promise<unknown>;
  parsers: () => Promise<unknown>;
  syncStatus: () => Promise<unknown>;
}

export interface BffDeps {
  resolveStaff: ResolveStaff;
  readers: BffReaders;
}

export function createBffApp(deps: BffDeps): Hono {
  const app = new Hono();

  // Use the Web-standard Response.json (not Hono's c.json) so the gated closure's response type stays shallow.
  const gated =
    (cap: Capability, read: () => Promise<unknown>) =>
    async (c: Context): Promise<Response> => {
      const principal = await deps.resolveStaff(c);
      if (!principal) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (!hasCapability(principal, cap)) {
        return Response.json({ error: "forbidden", capability: cap }, { status: 403 });
      }
      return Response.json(await read());
    };

  app.get("/bff/overview", gated("data:read", deps.readers.overview));
  app.get("/bff/review-tasks", gated("data:review", deps.readers.reviewTasks));
  app.get("/bff/parsers", gated("data:read", deps.readers.parsers));
  app.get("/bff/sync-status", gated("data:read", deps.readers.syncStatus));

  return app;
}
