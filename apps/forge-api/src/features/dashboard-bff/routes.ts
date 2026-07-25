// dashboard-bff — the read BFF the Forge operator console (apps/forge) talks to over fetchWithAuth (13, 03
// §The four services). Every route is capability-gated server-side — the console renders, it does not decide.
// Read models come from injected readers (db repos in prod), so the BFF is unit-testable. The gate is applied
// INSIDE each handler (not chained Hono middleware) to keep the route types shallow.
import { type Context, Hono } from "hono";
import { type Capability, type ResolveStaff, hasCapability } from "../../middleware/capability.ts";
import { problem } from "../../middleware/error.ts";

export interface BffReaders {
  overview: () => Promise<unknown>;
  reviewTasks: () => Promise<unknown>;
  parsers: () => Promise<unknown>;
  syncStatus: () => Promise<unknown>;
  captures: () => Promise<unknown>;
  /** Directory identity for /bff/me — email only, never the full user record. */
  identity: (userId: string) => Promise<{ email: string | null }>;
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
      if (!principal) return problem(401, "unauthorized", "Unauthorized");
      if (!hasCapability(principal, cap)) {
        return problem(403, "forbidden", "Forbidden", { capability: cap });
      }
      return Response.json(await read());
    };

  app.get("/bff/overview", gated("data:read", deps.readers.overview));
  app.get("/bff/review-tasks", gated("data:review", deps.readers.reviewTasks));
  app.get("/bff/parsers", gated("data:read", deps.readers.parsers));
  app.get("/bff/sync-status", gated("data:read", deps.readers.syncStatus));
  app.get("/bff/captures", gated("data:read", deps.readers.captures));

  // Authn-only (no capability): the caller reads their OWN role/capabilities/identity, like the main api's
  // /admin/me — a zero-capability staff account still gets its (empty) matrix so the console can render.
  app.get("/bff/me", async (c: Context): Promise<Response> => {
    const principal = await deps.resolveStaff(c);
    if (!principal) return problem(401, "unauthorized", "Unauthorized");
    const identity = await deps.readers.identity(principal.userId);
    return Response.json({
      staffRole: principal.staffRole ?? null,
      capabilities: principal.capabilities,
      email: identity.email,
    });
  });

  return app;
}
