// routes.ts — platform super-admin API (ADR-0032). authn + platformAdmin, NO tenancy: the caller reads
// ACROSS all tenants/workspaces via the audited withPlatformTx (the owner-role RLS bypass). Every read is
// recorded in platform_audit_log; results are bounded (PLATFORM_READ_LIMIT) — no unbounded cross-tenant
// scans. Transport only: the bounded read shapes live in @leadwolf/db (platformAdminRepository). This is the
// highest-privilege surface in the api; nothing reaches it without pa===true.
import { evaluateFlagsForTenant } from "@leadwolf/core";
import {
  PLATFORM_READ_LIMIT,
  featureFlagRepository,
  platformAdminRepository,
  withPlatformTx,
} from "@leadwolf/db";
import {
  NotFoundError,
  ValidationError,
  featureFlagGlobalToggleSchema,
  featureFlagTenantToggleSchema,
  featureFlagUpsertSchema,
} from "@leadwolf/types";
import { type Context, Hono } from "hono";
import { type ApiVariables, authn } from "../../middleware/authn.ts";
import { platformAdmin } from "../../middleware/platformAdmin.ts";
import { auditLogRoutes } from "./auditLog.ts";
import { impersonationRoutes } from "./impersonation.ts";
import { providerConfigRoutes } from "./providerConfigs.ts";
import { staffRoutes } from "./staff.ts";

// Accept any RFC-4122-shaped UUID (incl. the v7 ids this app mints) for path-param validation.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const detail = await withPlatformTx(
    actorOf(c),
    "admin.get_tenant",
    (tx) => platformAdminRepository.getTenantDetail(tx, tenantId),
    { targetType: "tenant", targetId: tenantId, tenantId },
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

// ── Feature flags (13 §3.5, ADR-0011) ──────────────────────────────────────────────────────────────────
// All reads + writes go through withPlatformTx: cross-tenant owner visibility + an in-tx platform_audit_log
// row. Writes use the ADR-0032 platform-audit action vocabulary (feature_flag.set). Flags are global +
// per-tenant override; the customer app role is read-only on these tables (rls/featureFlags.sql).

/** List every flag with its per-tenant overrides (the admin flags screen). Two bounded queries (defs +
 *  all overrides) grouped in memory — no per-flag N+1. */
adminRoutes.get("/feature-flags", async (c) => {
  const flags = await withPlatformTx(actorOf(c), "admin.list_feature_flags", async (tx) => {
    const [defs, overrides] = await Promise.all([
      featureFlagRepository.listGlobal(tx),
      featureFlagRepository.allOverrides(tx),
    ]);
    const byKey = new Map<string, { tenantId: string; enabled: boolean }[]>();
    for (const o of overrides) {
      const list = byKey.get(o.flagKey) ?? [];
      list.push({ tenantId: o.tenantId, enabled: o.enabled });
      byKey.set(o.flagKey, list);
    }
    return defs.map((def) => ({
      key: def.key,
      description: def.description,
      globalEnabled: def.globalEnabled,
      defaultEnabled: def.defaultEnabled,
      createdAt: def.createdAt.toISOString(),
      updatedAt: def.updatedAt.toISOString(),
      overrides: byKey.get(def.key) ?? [],
    }));
  });
  return c.json({ flags });
});

/** Define or update a flag (idempotent on key). Audited. */
adminRoutes.put("/feature-flags", async (c) => {
  const parsed = featureFlagUpsertSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const input = parsed.data;
  await withPlatformTx(actorOf(c), "feature_flag.set", (tx) =>
    featureFlagRepository.upsert(tx, {
      key: input.key,
      description: input.description,
      globalEnabled: input.global_enabled,
      defaultEnabled: input.default,
    }),
  );
  return c.json({ ok: true, key: input.key });
});

/** Toggle a flag's global default on/off. Audited. 404 if the flag is undefined — the NotFoundError is
 *  thrown INSIDE the tx so the audit row rolls back (a failed toggle leaves no "feature_flag.set" trace). */
adminRoutes.post("/feature-flags/:key/global", async (c) => {
  const key = c.req.param("key");
  const parsed = featureFlagGlobalToggleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  await withPlatformTx(actorOf(c), "feature_flag.set", async (tx) => {
    const found = await featureFlagRepository.setGlobal(tx, key, parsed.data.enabled);
    if (!found) throw new NotFoundError(`Unknown feature flag '${key}'.`);
  });
  return c.json({ ok: true, key, globalEnabled: parsed.data.enabled });
});

/** Set or clear a per-tenant override. `enabled: null` clears it. Audited. */
adminRoutes.post("/feature-flags/:key/tenant", async (c) => {
  const key = c.req.param("key");
  const parsed = featureFlagTenantToggleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const { tenant_id, enabled } = parsed.data;
  await withPlatformTx(
    actorOf(c),
    "feature_flag.set",
    async (tx) => {
      // The flag must exist before an override can reference it (FK + a clearer 404 than a constraint error).
      const def = await featureFlagRepository.getGlobal(tx, key);
      if (!def) throw new NotFoundError(`Unknown feature flag '${key}'.`);
      if (enabled === null) {
        await featureFlagRepository.clearTenantOverride(tx, key, tenant_id);
      } else {
        await featureFlagRepository.setTenantOverride(tx, key, tenant_id, enabled);
      }
    },
    { targetType: "feature_flag", targetId: key, tenantId: tenant_id, metadata: { enabled } },
  );
  return c.json({ ok: true, key, tenantId: tenant_id, enabled });
});

/** Preview the evaluated flag state for a tenant (per-tenant override else global default). Audited read.
 *  tenantId is validated as a UUID BEFORE the tx so a malformed id is a clean 422 with no audit row (and
 *  no raw Postgres 22P02 500). */
adminRoutes.get("/feature-flags/evaluate/:tenantId", async (c) => {
  const tenantId = c.req.param("tenantId");
  if (!UUID_RE.test(tenantId)) throw new ValidationError("tenantId must be a UUID");
  const flags = await withPlatformTx(actorOf(c), "admin.evaluate_feature_flags", (tx) =>
    evaluateFlagsForTenant(tx, tenantId),
  );
  return c.json({ tenantId, flags });
});

// ── Provider configs (13 §3.6) — enable/disable + monthly budget, super_admin-gated. Own module to keep
// this file focused; the parent authn + platformAdmin middleware already apply to the mounted sub-routes. ──
adminRoutes.route("/provider-configs", providerConfigRoutes);
// Platform audit-log viewer (super_admin|compliance_officer), staff RBAC + impersonation (super_admin/support).
adminRoutes.route("/audit-log", auditLogRoutes);
adminRoutes.route("/staff", staffRoutes);
adminRoutes.route("/impersonation", impersonationRoutes);
