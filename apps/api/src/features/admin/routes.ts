// routes.ts — platform super-admin API (ADR-0032). authn + platformAdmin, NO tenancy: the caller reads
// ACROSS all tenants/workspaces via the audited withPlatformTx (the owner-role RLS bypass). Every read is
// recorded in platform_audit_log; results are bounded (PLATFORM_READ_LIMIT) — no unbounded cross-tenant
// scans. Transport only: the bounded read shapes live in @leadwolf/db (platformAdminRepository). This is the
// highest-privilege surface in the api; nothing reaches it without pa===true.
import { PLATFORM_READ_LIMIT, platformAdminRepository, withPlatformTx } from "@leadwolf/db";
import { NotFoundError } from "@leadwolf/types";
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
    platformAdminRepository.listWorkspaces(tx),
  );
  return c.json({ workspaces });
});

adminRoutes.get("/users", async (c) => {
  const users = await withPlatformTx(actorOf(c), "admin.list_users", (tx) =>
    platformAdminRepository.listUsers(tx),
  );
  return c.json({ users });
});

// ── Tenants directory (13 §3.1) — plan / status / seats / credits per org, bounded cross-tenant read. ──
adminRoutes.get("/tenants", async (c) => {
  const tenants = await withPlatformTx(actorOf(c), "admin.list_tenants", (tx) =>
    platformAdminRepository.listTenants(tx),
  );
  return c.json({ tenants });
});

// ── Tenant detail (13 §3.1) — the org plus its workspaces + members. Each list is bounded. ──
adminRoutes.get("/tenants/:id", async (c) => {
  const tenantId = c.req.param("id");
  const detail = await withPlatformTx(actorOf(c), "admin.get_tenant", (tx) =>
    platformAdminRepository.getTenantDetail(tx, tenantId),
  );
  if (!detail) throw new NotFoundError("Tenant not found.");
  return c.json(detail);
});

// ── System health (13 §9) — service status + the bulk-enrichment job queue tallied by status (the
// queue-depth / DLQ proxy until the worker metrics surface lands). Bounded read, tallied in JS. ──
adminRoutes.get("/system-health", async (c) => {
  const statuses = await withPlatformTx(actorOf(c), "admin.system_health", (tx) =>
    platformAdminRepository.sampleJobStatuses(tx),
  );

  const byStatus: Record<string, number> = {};
  for (const s of statuses) byStatus[s] = (byStatus[s] ?? 0) + 1;

  const queueDepth = (byStatus.queued ?? 0) + (byStatus.running ?? 0) + (byStatus.estimating ?? 0);
  const deadLetter = byStatus.failed ?? 0;

  return c.json({
    // The api answered this request, so it is up; other services are reported as unknown until a
    // dedicated probe surface exists (do not fabricate green checks).
    services: [
      { name: "api", status: "up" },
      { name: "database", status: "up" },
      { name: "workers", status: "unknown" },
      { name: "redis", status: "unknown" },
      { name: "search", status: "unknown" },
    ],
    jobs: {
      sampleSize: statuses.length,
      truncated: statuses.length >= PLATFORM_READ_LIMIT,
      byStatus,
      queueDepth,
      deadLetter,
    },
  });
});
