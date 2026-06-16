// routes.ts — HTTP wiring for the workspaces feature (17 §5, 09 §3): GET / lists the workspaces the caller
// is an active member of within the current tenant, with their role in each (the workspace switcher's data).
// No active-workspace selection is required, so this sits behind authn + tenancy only. Transport only — the
// RLS-scoped membership read lives in the workspaces repository.

import { workspaceRepository } from "@leadwolf/db";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

export const workspacesRoutes = new Hono<{ Variables: TenancyVariables }>();

workspacesRoutes.use("*", authn);
workspacesRoutes.use("*", tenancy);

workspacesRoutes.get("/", async (c) => {
  const claims = c.get("claims");
  const workspaces = await workspaceRepository.listForUser(c.get("tenantId"), claims.sub);
  return c.json({ workspaces });
});
