// routes.ts — HTTP wiring for the Home dashboard (07 §2, 09 §3): GET /summary returns the workspace-scoped
// HomeSummary DTO. Authn + tenancy resolve the caller; requireRole gates membership (any active role); the
// composition + the PII-safety invariants live in core/db. Transport only — validated against the contract
// before it leaves the api so a drift in the shape fails loud here, not in the browser.
//
// Caching (perf): the summary is recomputed per request, but the response carries a body-derived weak ETag
// + a short private Cache-Control so a revisit/remount that sends If-None-Match gets a cheap 304 (no body) and
// the browser/client can serve-while-revalidate. The ETag is derived from the already-workspace-scoped JSON,
// so it is implicitly tenant/workspace-scoped (different scope → different bytes → different ETag), and
// `private` keeps this per-user PII-safe payload out of any shared/CDN cache (truepoint-platform caching,
// truepoint-security data-protection). Note: this is a transport win, not a server compute cache — a Redis
// per-workspace memo of the computed summary is a sensible follow-up, but that response-cache layer does not
// exist yet (caching.md implementation status), so it is intentionally out of scope here.

import { buildHomeSummary } from "@leadwolf/core";
import { ForbiddenError, homeSummarySchema } from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type RoleVariables, requireRole } from "../../middleware/requireRole.ts";
import { tenancy } from "../../middleware/tenancy.ts";

export const homeRoutes = new Hono<{ Variables: RoleVariables }>();

homeRoutes.use("*", authn);
homeRoutes.use("*", tenancy);

/** A weak ETag derived from the response bytes — stable for an unchanged summary, cheap to compute. */
function weakETag(body: string): string {
  return `W/"${Bun.hash(body).toString(16)}"`;
}

/** RFC 9110 §13.1.2: If-None-Match matches on `*`, or on any comma-listed validator (weak comparison). */
function ifNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((tag) => tag.trim() === etag);
}

homeRoutes.get("/summary", requireRole("owner", "admin", "member", "viewer"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to continue.");

  const summary = await buildHomeSummary({ scope: { tenantId: c.get("tenantId"), workspaceId } });
  const body = JSON.stringify(homeSummarySchema.parse(summary));
  const etag = weakETag(body);

  // Per-user, short-lived: safe to reuse on revisit, never shared (PII-safe but workspace-scoped).
  c.header("Cache-Control", "private, max-age=30");
  c.header("ETag", etag);

  // Honor a conditional request: an unchanged summary returns 304 with no body (skips the wire payload).
  if (ifNoneMatch(c.req.header("if-none-match"), etag)) return c.body(null, 304);

  c.header("Content-Type", "application/json");
  return c.body(body);
});
