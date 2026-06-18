// routes.ts — platform super-admin API (ADR-0032). authn + platformAdmin, NO tenancy: the caller reads
// ACROSS all tenants/workspaces via the audited withPlatformTx (the owner-role RLS bypass). Every read is
// recorded in platform_audit_log; results are bounded (limit 500) — no unbounded cross-tenant scans.
// Transport only. This is the highest-privilege surface in the api; nothing reaches it without pa===true.
import { evaluateFlagsForTenant } from "@leadwolf/core";
import { featureFlagRepository, schema, withPlatformTx } from "@leadwolf/db";
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
  await withPlatformTx(actorOf(c), "feature_flag.set", async (tx) => {
    // The flag must exist before an override can reference it (FK + a clearer 404 than a constraint error).
    const def = await featureFlagRepository.getGlobal(tx, key);
    if (!def) throw new NotFoundError(`Unknown feature flag '${key}'.`);
    if (enabled === null) {
      await featureFlagRepository.clearTenantOverride(tx, key, tenant_id);
    } else {
      await featureFlagRepository.setTenantOverride(tx, key, tenant_id, enabled);
    }
  });
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
