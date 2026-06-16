// routes.ts — platform super-admin API (ADR-0032). authn + platformAdmin, NO tenancy: the caller reads
// ACROSS all tenants/workspaces via the audited withPlatformTx (the owner-role RLS bypass). Every read is
// recorded in platform_audit_log; results are bounded (limit 500) — no unbounded cross-tenant scans.
// Transport only. This is the highest-privilege surface in the api; nothing reaches it without pa===true.
import { schema, withPlatformTx } from "@leadwolf/db";
import { type Context, Hono } from "hono";
import { type ApiVariables, authn } from "../../middleware/authn.ts";
import { platformAdmin } from "../../middleware/platformAdmin.ts";

export const adminRoutes = new Hono<{ Variables: ApiVariables }>();

adminRoutes.use("*", authn);
adminRoutes.use("*", platformAdmin);

const actorOf = (c: Context<{ Variables: ApiVariables }>) => ({
  userId: c.get("claims").sub,
  ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
});

adminRoutes.get("/workspaces", async (c) => {
  const workspaces = await withPlatformTx(actorOf(c), "admin.list_workspaces", (tx) =>
    tx
      .select({
        id: schema.workspaces.id,
        name: schema.workspaces.name,
        slug: schema.workspaces.slug,
        tenantId: schema.workspaces.tenantId,
      })
      .from(schema.workspaces)
      .limit(500),
  );
  return c.json({ workspaces });
});

adminRoutes.get("/users", async (c) => {
  const users = await withPlatformTx(actorOf(c), "admin.list_users", (tx) =>
    tx
      .select({
        id: schema.users.id,
        email: schema.users.email,
        fullName: schema.users.fullName,
        status: schema.users.status,
        isPlatformAdmin: schema.users.isPlatformAdmin,
      })
      .from(schema.users)
      .limit(500),
  );
  return c.json({ users });
});
