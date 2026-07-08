// routes.ts — HTTP wiring for the workspace auto-enrich policy settings (G-ENR-1; 29 §3, 09 §3):
//   GET   /api/v1/settings/auto-enrich   → the resolved policy + month-to-date spend
//   PATCH /api/v1/settings/auto-enrich   → update (partial; arrays replace) → resolved policy + spend
// Transport only: validate the body, then read/write through the repository (RLS workspace-scoped). The
// resolve-default + partial-merge live in the repository (applyPartial is an atomic read-merge-upsert, so
// concurrent PATCHes can't lost-update). No enrichment is triggered here — this configures the policy the
// core guard (enforceAutoEnrichPolicy) consults on a system-initiated enrich.

import { resolvePolicyFromRows, validatePolicyWrite } from "@leadwolf/auth";
import {
  auditRepository,
  authPolicyRepository,
  effectivePolicyRepository,
  enrichmentPolicyRepository,
} from "@leadwolf/db";
import {
  type AuthPolicy,
  type EnrichmentPolicyResponse,
  ForbiddenError,
  ValidationError,
  authPolicySchema,
  updateEnrichmentPolicySchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { requireOrgRole } from "../../middleware/requireOrgRole.ts";
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
