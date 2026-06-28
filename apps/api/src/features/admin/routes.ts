// routes.ts — platform super-admin API (ADR-0032). authn + platformAdmin, NO tenancy: the caller reads
// ACROSS all tenants/workspaces via the audited withPlatformTx (the owner-role RLS bypass). Every read is
// recorded in platform_audit_log; results are bounded (PLATFORM_READ_LIMIT) — no unbounded cross-tenant
// scans. Transport only: the bounded read shapes live in @leadwolf/db (platformAdminRepository). This is the
// highest-privilege surface in the api; nothing reaches it without pa===true.
import { evaluateFlagsForTenant } from "@leadwolf/core";
import {
  PLATFORM_READ_LIMIT,
  authPolicyRepository,
  featureFlagRepository,
  platformAdminRepository,
  retentionPolicyRepository,
  withPlatformTx,
} from "@leadwolf/db";
import {
  LIST_PLATFORM_AUDIT_ACTIONS,
  NotFoundError,
  type StaffListOverview,
  ValidationError,
  featureFlagGlobalToggleSchema,
  featureFlagTenantToggleSchema,
  featureFlagUpsertSchema,
  retentionPolicySchema,
  retentionPolicyUpdateSchema,
  setAuthEnforcementSchema,
} from "@leadwolf/types";
import { type Context, Hono } from "hono";
import { type ApiVariables, authn } from "../../middleware/authn.ts";
import { platformAdmin } from "../../middleware/platformAdmin.ts";
import { requireStaffRole } from "../../middleware/requireStaffRole.ts";
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

// ── Staff lists-overview (list-plan/07 §3.1, D2) — the PRIVACY-FIRST staff view of a tenant's lists. ──────
// Returns per-list METADATA + an AGGREGATE member COUNT only — NO list_members, NO contact PII. This is the
// legitimate operating surface: a staff tier may see the container (name/owner/count), NONE may read its
// members here. Record-level access is reachable ONLY through break-glass impersonation (the separate
// /impersonation surface, which sets the workspace GUC under leadwolf_app).
//
// Role gate (capability matrix, list-plan/07 §2): super_admin / support / compliance_officer / read_only may
// read the full list metadata. `billing_ops` is DELIBERATELY EXCLUDED — the matrix limits billing_ops to
// "List metadata: counts only", and this surface returns names/descriptions, which exceeds that tier; the
// billing surface gets aggregate counts elsewhere (the tenants directory / usage analytics). The read runs
// through the audited withPlatformTx (an admin.list.view_metadata row names the tenant); the tenantId is
// validated as a UUID BEFORE the tx so a malformed id is a clean 422 with no audit row.
adminRoutes.get(
  "/tenants/:tenantId/lists",
  requireStaffRole("super_admin", "support", "compliance_officer", "read_only"),
  async (c) => {
    const tenantId = c.req.param("tenantId");
    if (!UUID_RE.test(tenantId)) throw new ValidationError("tenantId must be a UUID");
    const rows = await withPlatformTx(
      actorOf(c),
      LIST_PLATFORM_AUDIT_ACTIONS.viewMetadata,
      (tx) => platformAdminRepository.listTenantListsOverview(tx, tenantId),
      { targetType: "tenant", targetId: tenantId, tenantId },
    );
    const lists: StaffListOverview[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      ownerUserId: r.ownerUserId,
      memberCount: r.memberCount,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
    return c.json({ lists });
  },
);

// ── Auth-policy enforcement master switch (P1-01) — STAFF-ONLY per-tenant enable + break-glass disable. ──
// The lockout-capable login gates (IP allowlist / allowed methods / session + idle timeout / forced-MFA
// enrollment, packages/auth) fire only when BOTH the global env master-arm AND this per-tenant switch are on.
// A super_admin enables enforcement for a VERIFIED tenant; the `enabled:false` direction IS the break-glass —
// it re-opens password/all-method login within the ≤15-min token window WITHOUT a deploy. The write is
// audited (admin.set_auth_enforcement) in the SAME withPlatformTx tx; the tenantId is validated as a UUID
// BEFORE the tx so a malformed id is a clean 422 with no audit row. Tenant security_admins can never reach
// this switch (it is absent from the tenant-editable authPolicySchema), so an org cannot self-lock-out.
adminRoutes.post(
  "/tenants/:tenantId/auth-enforcement",
  requireStaffRole("super_admin"),
  async (c) => {
    const tenantId = c.req.param("tenantId");
    if (!UUID_RE.test(tenantId)) throw new ValidationError("tenantId must be a UUID");
    const parsed = setAuthEnforcementSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
    const { enabled } = parsed.data;
    await withPlatformTx(
      actorOf(c),
      "admin.set_auth_enforcement",
      (tx) => authPolicyRepository.setEnforcement(tx, tenantId, enabled),
      { targetType: "tenant", targetId: tenantId, tenantId, metadata: { enabled } },
    );
    return c.json({ ok: true, tenantId, enforcementEnabled: enabled });
  },
);

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

// ── Import-jobs monitor (data-management A4; 15-bulk-import-design) — recent bulk-import jobs ACROSS all
// tenants, the staff rollout-monitoring feed for the COPY-staging pipeline. Per-job status / av-scan / row
// tallies / failure reason joined to the tenant name, newest-first + bounded (PLATFORM_READ_LIMIT). View-only
// staff tiers may read (super_admin always passes); the read runs on the audited withPlatformTx. The action
// `admin.list_import_jobs` is a READ — like admin.list_tenants / admin.list_users it is a plain withPlatformTx
// string and is deliberately NOT in the platformAuditAction mutation enum (only writes are enum-tracked).
// METADATA + tallies only (the repo selects import_jobs, never import_job_rows) — no imported contact PII
// leaves the boundary. Read-only: no actions on this surface. The repo shape is returned directly via c.json
// (no Zod schema), matching the sibling cross-tenant list reads (tenants / users / workspaces).
adminRoutes.get(
  "/import-jobs",
  requireStaffRole("super_admin", "support", "read_only"),
  async (c) => {
    const jobs = await withPlatformTx(actorOf(c), "admin.list_import_jobs", (tx) =>
      platformAdminRepository.recentImportJobs(tx),
    );
    return c.json({ jobs });
  },
);

// ── Retention-runs review (data-management A5; 16-retention-engine-design) — recent retention-engine RUNS
// ACROSS all tenants, the SHADOW evidence operators review BEFORE flipping a class to `enforce`. Per-run class /
// mode / candidate ["would delete"] + deleted tallies / cutoff / run timestamps joined to the tenant name,
// newest-first + bounded (PLATFORM_READ_LIMIT). The view-only compliance/read tiers may read (super_admin always
// passes); the read runs on the audited withPlatformTx. The action `admin.list_retention_runs` is a READ —
// like admin.list_import_jobs / admin.list_tenants it is a plain withPlatformTx string and is deliberately NOT
// in the platformAuditAction mutation enum (only writes are enum-tracked). COUNTS-only (retention_runs carries
// no contact rows / PII) — nothing sensitive leaves the boundary. Read-only: no actions on this surface. The
// repo shape is returned directly via c.json (no Zod schema), matching the sibling cross-tenant reads.
adminRoutes.get(
  "/retention-runs",
  requireStaffRole("super_admin", "compliance_officer", "read_only"),
  async (c) => {
    const runs = await withPlatformTx(actorOf(c), "admin.list_retention_runs", (tx) =>
      platformAdminRepository.recentRetentionRuns(tx),
    );
    return c.json({ runs });
  },
);

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

// ── Global retention policies (data-management A2; design 16-retention-engine-design.md) ─────────────────
// One GLOBAL policy per data class: its TTL (null = never) + its disabled|shadow|enforce mode. The store is
// platform-managed (no tenant_id) and the customer app role has NO write policy under FORCE RLS, so both the
// read and the write run on the audited withPlatformTx (the owner path). The READ is open to the view-only
// staff tiers; the WRITE arms real deletion when a class is flipped to `enforce`, so it is super_admin-ONLY
// and audited (retention_policy.set). The per-tenant `retention_engine_enabled` flag is the outer gate on
// the sweep — a policy never deletes for a tenant that has the engine off.

/** List every global retention policy. View-only staff tiers may read; the write below is super_admin only.
 *  Response is Zod-validated against the shared RetentionPolicy contract before it leaves the boundary. */
adminRoutes.get(
  "/retention-policies",
  requireStaffRole("super_admin", "compliance_officer", "read_only"),
  async (c) => {
    const policies = await withPlatformTx(actorOf(c), "admin.list_retention_policies", (tx) =>
      retentionPolicyRepository.listPolicies(tx),
    );
    return c.json({ policies: retentionPolicySchema.array().parse(policies) });
  },
);

/** Define or update a class's policy (idempotent on data class). super_admin ONLY — flipping `mode` to
 *  `enforce` ARMS permanent deletion for that class — and AUDITED (retention_policy.set, with the class +
 *  new ttl/mode as the target/metadata). The upsert runs on withPlatformTx: under FORCE RLS the app role has
 *  no write policy on retention_policies, so the write MUST run on the owner path. dataClass is validated as
 *  a real retentionDataClass by the body schema (retentionPolicyUpdateSchema). FUTURE: a compliance_officer
 *  co-sign (dual-control) could be required on the enforce flip — a separate approval workflow, out of scope
 *  here; today the controls are super_admin-only + audit + the UI confirm dialog. */
adminRoutes.put("/retention-policies", requireStaffRole("super_admin"), async (c) => {
  const parsed = retentionPolicyUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const policy = parsed.data;
  await withPlatformTx(
    actorOf(c),
    "retention_policy.set",
    (tx) => retentionPolicyRepository.upsertPolicy(tx, policy),
    {
      targetType: "retention_policy",
      targetId: policy.dataClass,
      metadata: { ttlDays: policy.ttlDays, mode: policy.mode },
    },
  );
  return c.json({ ok: true, dataClass: policy.dataClass });
});

// ── Provider configs (13 §3.6) — enable/disable + monthly budget, super_admin-gated. Own module to keep
// this file focused; the parent authn + platformAdmin middleware already apply to the mounted sub-routes. ──
adminRoutes.route("/provider-configs", providerConfigRoutes);
// Platform audit-log viewer (super_admin|compliance_officer), staff RBAC + impersonation (super_admin/support).
adminRoutes.route("/audit-log", auditLogRoutes);
adminRoutes.route("/staff", staffRoutes);
adminRoutes.route("/impersonation", impersonationRoutes);
