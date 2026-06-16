// routes.ts — HTTP wiring for the auth feature on the app API (09 §2). GET /session returns the caller's
// identity derived from the verified access token. Token issuance/refresh lives on the auth origin
// (apps/auth), not here. This file is the ONLY place that touches req/res for this feature.

import { workspaceRepository } from "@leadwolf/db";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

export const authRoutes = new Hono<{ Variables: TenancyVariables }>();

authRoutes.use("*", authn);
authRoutes.use("*", tenancy);

authRoutes.get("/session", async (c) => {
  const claims = c.get("claims");
  // The caller's role in the active workspace (null until a workspace is selected, or if not a member).
  const role = claims.wid
    ? await workspaceRepository.getRoleForUser(claims.tid, claims.wid, claims.sub)
    : null;
  return c.json({
    userId: claims.sub,
    tenantId: claims.tid,
    workspaceId: claims.wid ?? null,
    scope: claims.scope,
    role,
  });
});
