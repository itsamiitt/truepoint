// routes.ts — HTTP wiring for the workspace auto-enrich policy settings (G-ENR-1; 29 §3, 09 §3):
//   GET   /api/v1/settings/auto-enrich   → the resolved policy + month-to-date spend
//   PATCH /api/v1/settings/auto-enrich   → update (partial; arrays replace) → resolved policy + spend
// Transport only: validate the body, then read/write through the repository (RLS workspace-scoped). The
// resolve-default + partial-merge live in the repository (applyPartial is an atomic read-merge-upsert, so
// concurrent PATCHes can't lost-update). No enrichment is triggered here — this configures the policy the
// core guard (enforceAutoEnrichPolicy) consults on a system-initiated enrich.

import { auditRepository, authPolicyRepository, enrichmentPolicyRepository } from "@leadwolf/db";
import {
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
