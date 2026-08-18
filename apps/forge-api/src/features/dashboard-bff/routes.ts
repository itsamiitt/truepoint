// dashboard-bff — the read BFF the Forge operator console (apps/forge) talks to over fetchWithAuth (13, 03
// §The four services). Every route is capability-gated server-side — the console renders, it does not decide.
// Read models come from injected readers (db repos in prod), so the BFF is unit-testable. The gate is applied
// INSIDE each handler (not chained Hono middleware) to keep the route types shallow.
import type { PlatformAuditAction } from "@leadwolf/types";
import { type Context, Hono } from "hono";
import { type Capability, type ResolveStaff, hasCapability } from "../../middleware/capability.ts";
import { problem } from "../../middleware/error.ts";

export interface BffReaders {
  overview: () => Promise<unknown>;
  reviewTasks: () => Promise<unknown>;
  parsers: () => Promise<unknown>;
  syncStatus: () => Promise<unknown>;
  captures: () => Promise<unknown>;
  /** The live source-fetch registry telemetry (URLs + outcomes, no PII) — extension-intelligence-loop. */
  sourceFetches: () => Promise<unknown>;
  /** Directory identity for /bff/me — email only, never the full user record. */
  identity: (userId: string) => Promise<{ email: string | null }>;
}

/** Writes the ADR-0032 platform_audit_log row for a staff cross-tenant read. Injected like the readers so the
 *  BFF stays unit-testable, and so the composition root owns the fact that it runs on the OWNER connection —
 *  it cannot share the readers' transaction, because those run as `leadwolf_forge`, which owns only the forge
 *  schema and has no grant on the public-schema audit table. */
export type BffAudit = (entry: {
  actorUserId: string;
  /** Constrained to the closed platform_audit_log vocabulary (ADR-0032) so a route cannot invent an action
   *  name that no audit-log reader or filter knows about. */
  action: PlatformAuditAction;
  ip: string | null;
  metadata: Record<string, unknown>;
}) => Promise<void>;

export interface BffDeps {
  resolveStaff: ResolveStaff;
  readers: BffReaders;
  audit: BffAudit;
}

export function createBffApp(deps: BffDeps): Hono {
  const app = new Hono();

  // Use the Web-standard Response.json (not Hono's c.json) so the gated closure's response type stays shallow.
  const gated =
    (cap: Capability, action: PlatformAuditAction, read: () => Promise<unknown>) =>
    async (c: Context): Promise<Response> => {
      const principal = await deps.resolveStaff(c);
      if (!principal) return problem(401, "unauthorized", "Unauthorized");
      if (!hasCapability(principal, cap)) {
        return problem(403, "forbidden", "Forbidden", { capability: cap });
      }
      // ADR-0032: a staff member reading across tenants is a privileged action and leaves a trail. Every one of
      // these reads happens while the console shows a standing "Cross-tenant view" badge, and none of them
      // recorded anything — the same reads in apps/api (admin.read_audit_log, admin.list_dsars, …) have always
      // been audited, so this was the Forge console diverging from the house rule, not a different rule.
      //
      // The row is written BEFORE the read and in its own transaction. Same-transaction is the ideal and is
      // what withPlatformTx does elsewhere, but it is not reachable here: the readers run as `leadwolf_forge`,
      // which has no grant on public.platform_audit_log. Audit-first preserves the property that actually
      // matters — a read cannot happen without its trail, because a failed audit write throws before the read
      // runs. The residual is over-logging (a logged read whose query then failed), which is the safe
      // direction for an audit log.
      await deps.audit({
        actorUserId: principal.userId,
        action,
        ip: c.req.header("x-forwarded-for") ?? null,
        metadata: { capability: cap, path: new URL(c.req.url).pathname },
      });
      return Response.json(await read());
    };

  app.get("/bff/overview", gated("data:read", "forge.read_overview", deps.readers.overview));
  app.get(
    "/bff/review-tasks",
    gated("data:review", "forge.read_review_tasks", deps.readers.reviewTasks),
  );
  app.get("/bff/parsers", gated("data:read", "forge.read_parsers", deps.readers.parsers));
  app.get(
    "/bff/sync-status",
    gated("data:read", "forge.read_sync_status", deps.readers.syncStatus),
  );
  app.get("/bff/captures", gated("data:read", "forge.read_captures", deps.readers.captures));
  app.get(
    "/bff/source-fetches",
    gated("data:read", "forge.read_source_fetches", deps.readers.sourceFetches),
  );

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
