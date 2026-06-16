// routes.ts — HTTP wiring for the Home dashboard (07 §2, 09 §3): GET /summary returns the workspace-scoped
// HomeSummary DTO. Authn + tenancy resolve the caller; requireRole gates membership (any active role); the
// composition + the PII-safety invariants live in core/db. Transport only — validated against the contract
// before it leaves the api so a drift in the shape fails loud here, not in the browser.

import { buildHomeSummary } from "@leadwolf/core";
import { ForbiddenError, homeSummarySchema } from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type RoleVariables, requireRole } from "../../middleware/requireRole.ts";
import { tenancy } from "../../middleware/tenancy.ts";

export const homeRoutes = new Hono<{ Variables: RoleVariables }>();

homeRoutes.use("*", authn);
homeRoutes.use("*", tenancy);

homeRoutes.get("/summary", requireRole("owner", "admin", "member", "viewer"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to continue.");

  const summary = await buildHomeSummary({ scope: { tenantId: c.get("tenantId"), workspaceId } });
  return c.json(homeSummarySchema.parse(summary));
});
