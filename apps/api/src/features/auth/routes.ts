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
  // ?include=workspaces folds the workspace switcher's directory read into the boot probe (perf-audit
  // P3.5b): the web shell pays ONE request per hard load instead of two. Opt-in + additive, so every other
  // session consumer (extension, hooks, admin tooling) keeps the lean payload. Same projection as
  // GET /workspaces — both call listForUser. Orgs deliberately NOT folded (the auth origin owns org
  // membership); teams not folded (M15 seam — nothing to return yet).
  const workspaces =
    c.req.query("include") === "workspaces"
      ? await workspaceRepository.listForUser(claims.tid, claims.sub)
      : undefined;
  return c.json({
    userId: claims.sub,
    tenantId: claims.tid,
    workspaceId: claims.wid ?? null,
    scope: claims.scope,
    role,
    ...(workspaces !== undefined ? { workspaces } : {}),
  });
});
