// routes.ts — HTTP wiring for the workspace auto-enrich policy settings (G-ENR-1; 29 §3, 09 §3):
//   GET   /api/v1/settings/auto-enrich   → the resolved policy + month-to-date spend
//   PATCH /api/v1/settings/auto-enrich   → update (partial; arrays replace) → resolved policy + spend
// Transport only: validate the body, then read/write through the repository (RLS workspace-scoped). The
// resolve-default + partial-merge live in the repository (applyPartial is an atomic read-merge-upsert, so
// concurrent PATCHes can't lost-update). No enrichment is triggered here — this configures the policy the
// core guard (enforceAutoEnrichPolicy) consults on a system-initiated enrich.

import { resolvePolicyFromRows, ssoReadyForEnforcement, validatePolicyWrite } from "@leadwolf/auth";
import { writeAudit } from "@leadwolf/core";
import {
  auditRepository,
  authPolicyRepository,
  effectivePolicyRepository,
  enrichmentPolicyRepository,
  importPolicyRepository,
  ssoConfigRepository,
  withTenantTx,
} from "@leadwolf/db";
import {
  type AuthPolicy,
  DEFAULT_IMPORT_POLICY,
  type EnrichmentPolicyResponse,
  ForbiddenError,
  type ImportPolicyResponse,
  ValidationError,
  authPolicySchema,
  importPolicyResponseSchema,
  updateEnrichmentPolicySchema,
  updateImportPolicySchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { requireOrgRole } from "../../middleware/requireOrgRole.ts";
import { requireRole } from "../../middleware/requireRole.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";
import { identityRoutes } from "./identityRoutes.ts";
import { ssoRoutes } from "./ssoRoutes.ts";

export const settingsRoutes = new Hono<{ Variables: TenancyVariables }>();

settingsRoutes.use("*", authn);
settingsRoutes.use("*", tenancy);

/** The resolved policy (off-by-default for an unconfigured workspace) bundled with the live month-to-date spend. */
async function loadPolicyResponse(scope: {
  tenantId: string;
  workspaceId: string;
}): Promise<EnrichmentPolicyResponse> {
  const [policy, monthlySpentMicros] = await Promise.all([
    enrichmentPolicyRepository.resolved(scope),
    enrichmentPolicyRepository.monthlySpentMicros(scope),
  ]);
  return { ...policy, monthlySpentMicros };
}

settingsRoutes.get("/auto-enrich", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to view its auto-enrich policy.");
  const response = await loadPolicyResponse({ tenantId: c.get("tenantId"), workspaceId });
  return c.json(response, 200);
});

settingsRoutes.patch("/auto-enrich", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError(
      "no_workspace",
      "Select a workspace to update its auto-enrich policy.",
    );
  const tenantId = c.get("tenantId");
  const scope = { tenantId, workspaceId };

  const parsed = updateEnrichmentPolicySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError("Invalid auto-enrich policy.", { issues: parsed.error.issues });

  // Atomic merge-persist in the repository (arrays replace; absent fields keep the current value).
  await enrichmentPolicyRepository.applyPartial(scope, { tenantId, workspaceId }, parsed.data);
  const response = await loadPolicyResponse(scope);
  return c.json(response, 200);
});

// ── Workspace import policy (import-redesign 10 §3, S-V4; G02): the named "import at all" grant knob
// (`whoCanImport`) + the 08 §5 strategy defaults, one row per workspace. NEW surface — strict from birth
// (10 §5 row 11, no flag): admin/owner only on BOTH verbs (13 §7 route table). The PUT is a read-merge-
// upsert AND its `import.policy_updated` audit row in ONE tenant tx — a policy change without its audit
// trail cannot commit (T-V6). Enforcement of the knob lives in requireImportCreateGrant (dual-gated). ──

/** The resolved policy + last-change attribution (null = never user-set). */
function toImportPolicyResponse(
  record: Awaited<ReturnType<typeof importPolicyRepository.get>>,
): ImportPolicyResponse {
  if (!record) return { ...DEFAULT_IMPORT_POLICY, updatedByUserId: null, updatedAt: null };
  return {
    whoCanImport: record.whoCanImport,
    defaultMergeMode: record.defaultMergeMode,
    defaultPreservePopulated: record.defaultPreservePopulated,
    updatedByUserId: record.updatedByUserId,
    updatedAt: record.updatedAt.toISOString(),
  };
}

settingsRoutes.get("/import-policy", requireRole("owner", "admin"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to view its import policy.");
  const record = await importPolicyRepository.get({ tenantId: c.get("tenantId"), workspaceId });
  return c.json(importPolicyResponseSchema.parse(toImportPolicyResponse(record)), 200);
});

settingsRoutes.put("/import-policy", requireRole("owner", "admin"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to update its import policy.");
  const tenantId = c.get("tenantId");
  const actorUserId = c.get("claims").sub;

  const parsed = updateImportPolicySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError("Invalid import policy.", { issues: parsed.error.issues });
  const patch = parsed.data;

  // ONE tx: read-merge-upsert (concurrent PUTs can't lost-update) + the in-tx audit row (ruling M1's
  // Phase-0 action — the CHECK extension rode S-V1's migration train).
  const record = await withTenantTx({ tenantId, workspaceId }, async (tx) => {
    const current = await importPolicyRepository.getInTx(tx);
    const base = current ?? { ...DEFAULT_IMPORT_POLICY, updatedByUserId: null, updatedAt: null };
    const next = await importPolicyRepository.upsertInTx(tx, {
      tenantId,
      workspaceId,
      whoCanImport: patch.whoCanImport ?? base.whoCanImport,
      defaultMergeMode: patch.defaultMergeMode ?? base.defaultMergeMode,
      defaultPreservePopulated: patch.defaultPreservePopulated ?? base.defaultPreservePopulated,
      updatedByUserId: actorUserId,
    });
    await writeAudit(tx, {
      tenantId,
      workspaceId,
      actorUserId,
      action: "import.policy_updated",
      entityType: "import_policy",
      entityId: workspaceId,
      // Non-PII policy facets only — never request-body echoes.
      metadata: {
        whoCanImport: next.whoCanImport,
        defaultMergeMode: next.defaultMergeMode,
        defaultPreservePopulated: next.defaultPreservePopulated,
      },
      ipAddress: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: c.req.header("user-agent") ?? null,
    });
    return next;
  });
  return c.json(importPolicyResponseSchema.parse(toImportPolicyResponse(record)), 200);
});

// ── Tenant auth policy (Auth Admin ▸ Security & Access, ADR-0018, 17 §10). TENANT-scoped (not a workspace
// setting) and gated to security_admin or owner. The raw per-tenant policy the org configures; the
// strictest-wins resolution applied at login lives in packages/auth. The PUT is audited in the repository. ──
settingsRoutes.get(
  "/security/auth-policy",
  requireOrgRole("security_admin", "owner"),
  async (c) => {
    const policy = await authPolicyRepository.getForTenant(c.get("tenantId"));
    return c.json(policy, 200);
  },
);

settingsRoutes.put(
  "/security/auth-policy",
  requireOrgRole("security_admin", "owner"),
  async (c) => {
    const parsed = authPolicySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new ValidationError("Invalid auth policy.", { issues: parsed.error.issues });
    await authPolicyRepository.upsert(c.get("tenantId"), parsed.data, c.get("claims").sub);
    return c.json(parsed.data, 200);
  },
);

// ── Effective auth-policy engine (Phase 1, doc 11 §3 / doc 12) — the generalized store that SUBSUMES the
// per-tenant policy above. GET returns the RESOLVED effective policy (platform default → this org,
// strictest-wins); PUT writes ONE org-scoped key after the value-shape + security-floor guards. The
// DB primitives (getScopeRows / upsertTenantKey) + the pure validatePolicyWrite decision are CI-proven; this
// route is the thin orchestration. security_admin|owner. ──

// The hardcoded platform FLOOR (mirrors authPolicyRepository DEFAULT_POLICY): the base the resolver composes
// platform rows onto, and the minimum an org write may never loosen below.
const POLICY_FLOOR: AuthPolicy = {
  mfaEnforcement: "optional",
  allowedMethods: ["password", "oauth", "magic_link", "sso", "passkey"],
  disableSocial: false,
  requireSso: false,
  ipAllowlist: [],
};

settingsRoutes.get(
  "/security/effective-policy",
  requireOrgRole("security_admin", "owner"),
  async (c) => {
    const rows = await effectivePolicyRepository.getScopeRows({ tenantId: c.get("tenantId") });
    // Full chain (platform → this org); no workspace scope at the org-settings surface.
    return c.json(resolvePolicyFromRows(rows, undefined, POLICY_FLOOR), 200);
  },
);

settingsRoutes.put(
  "/security/effective-policy",
  requireOrgRole("security_admin", "owner"),
  async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      key?: unknown;
      value?: unknown;
    } | null;
    if (!body || typeof body.key !== "string") {
      throw new ValidationError("Expected a { key, value } body.");
    }
    // The floor an org write may not loosen below = the resolved PLATFORM default (platform rows over the code
    // floor), deliberately WITHOUT this org's own overrides.
    const rows = await effectivePolicyRepository.getScopeRows({ tenantId: c.get("tenantId") });
    const platformFloor = resolvePolicyFromRows(
      rows.filter((r) => r.scope === "platform"),
      undefined,
      POLICY_FLOOR,
    );
    const decision = validatePolicyWrite(body.key, body.value, platformFloor);
    if (!decision.ok) {
      if (decision.reason === "below_floor") {
        throw new ForbiddenError(
          "policy_below_floor",
          `This value would loosen a security key below the platform minimum: ${decision.violations?.join(", ")}.`,
        );
      }
      throw new ValidationError(
        decision.reason === "unknown_key" ? "Unknown policy key." : "Invalid value for this key.",
      );
    }
    // No-lockout guard (AUTH-031): forcing SSO (`require_sso=true`) permits ONLY the "sso" method, so if the org's
    // SSO connection isn't enabled + backed by a wired provider, enabling it would lock everyone out (the adapter
    // throws). Reject until a working connection exists. Only gates the ENABLE (value===true); disabling is free.
    if (body.key === "require_sso" && decision.value === true) {
      const ssoConfig = await ssoConfigRepository.getForTenant(c.get("tenantId"));
      if (!ssoReadyForEnforcement(ssoConfig)) {
        throw new ForbiddenError(
          "sso_not_ready",
          "Configure, enable, and test a working SSO connection before requiring SSO for this organization.",
        );
      }
    }
    await effectivePolicyRepository.upsertTenantKey({
      tenantId: c.get("tenantId"),
      scope: "org",
      key: body.key,
      value: decision.value,
      actorUserId: c.get("claims").sub,
    });
    return c.json({ key: body.key, value: decision.value }, 200);
  },
);

// Recent auth events for the org (login/MFA/SSO/session/token) — the security-review feed. Read-only,
// security_admin|owner, shaped to non-PII-heavy fields. Bounded to the 100 most recent.
settingsRoutes.get("/security/auth-audit", requireOrgRole("security_admin", "owner"), async (c) => {
  const events = await auditRepository.listAuthEvents({ tenantId: c.get("tenantId") }, 100);
  return c.json({ events: events.map((e) => ({ ...e, occurredAt: e.occurredAt.toISOString() })) });
});

// ── Auth Admin sub-routers — SSO config + domains/SCIM. Parent applies authn + tenancy; each child gates
// with requireOrgRole(security_admin|owner) on its own routes. ──────────────────────────────────────────
settingsRoutes.route("/security/sso", ssoRoutes);
settingsRoutes.route("/security/identity", identityRoutes);
