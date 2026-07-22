// routes.ts — HTTP wiring for the extension's identity reads (chrome-extension/14 X03/X04). The access JWT
// carries no name/email (only sub/tid/wid), so GET /me is a Bearer identity read for the popup/panel display,
// and GET /orgs lists the caller's orgs (across tenants) for the workspace/org switcher. Both derive scope from
// the verified token and are keyed by the caller's OWN sub — a user only ever sees their own identity and
// memberships. Transport only; the reads live in the db layer.
import { tenantMemberRepository, userRepository, workspaceRepository } from "@leadwolf/db";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

// GET /api/v1/me — the display identity (name/email/avatar/workspace) the extension popup shows. The `users`
// table has no avatar column today → avatarUrl is null. workspaceName resolves from the caller's active wid
// (their own workspaces only, RLS-scoped). Mirrors the /api/v1/auth GET /session identity assembly.
export const meRoutes = new Hono<{ Variables: TenancyVariables }>();
meRoutes.use("*", authn);
meRoutes.use("*", tenancy);

meRoutes.get("/", async (c) => {
  const claims = c.get("claims");
  const user = await userRepository.findById(claims.sub);
  let workspaceName: string | null = null;
  if (claims.wid) {
    const workspaces = await workspaceRepository.listForUser(claims.tid, claims.sub);
    workspaceName = workspaces.find((w) => w.id === claims.wid)?.name ?? null;
  }
  return c.json({
    name: user?.fullName ?? null,
    email: user?.email ?? null,
    avatarUrl: null,
    workspaceName,
  });
});

// GET /api/v1/orgs — the caller's orgs (across tenants) for the extension's org switcher, keyed by the token's
// sub so a user only ever sees their OWN memberships. activeTenantId is the token's current tid. Mirrors the
// web app's pre-tenant orgs read (tenantMemberRepository.listForUser). The response shape matches the
// extension's `{ orgs: OrgSummary[]; activeTenantId }` (OrgSummary = { tenantId, tenantName, isTenantOwner }).
export const orgsRoutes = new Hono<{ Variables: TenancyVariables }>();
orgsRoutes.use("*", authn);
orgsRoutes.use("*", tenancy);

orgsRoutes.get("/", async (c) => {
  const claims = c.get("claims");
  const orgs = await tenantMemberRepository.listForUser(claims.sub);
  return c.json({ orgs, activeTenantId: claims.tid ?? null });
});
