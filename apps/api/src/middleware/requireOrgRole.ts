// requireOrgRole.ts — authorize a TENANT/ORG-scoped route by the caller's active org role (ADR-0030). Runs
// AFTER authn + tenancy: it resolves org_role from tenant_members (RLS-scoped to the session tenant) and
// rejects 403 when the caller is not an active member or the role is not allowed. `owner` implies every org
// capability, so it always passes. The Auth Admin (Security & Access) endpoints sit behind this.

import { tenantMemberRepository } from "@leadwolf/db";
import { ForbiddenError, type OrgRole } from "@leadwolf/types";
import type { Context, MiddlewareHandler } from "hono";
import type { TenancyVariables } from "./tenancy.ts";

export type OrgRoleVariables = TenancyVariables & { orgRole: OrgRole };

/** Guard a route to the given org roles, resolved from the caller's tenant membership. `owner` always passes. */
export function requireOrgRole(...allowed: OrgRole[]): MiddlewareHandler {
  return async (c, next) => {
    const claims = c.get("claims");
    const tenantId = c.get("tenantId") as string;
    const role = await tenantMemberRepository.getOrgRole(tenantId, claims.sub);
    if (!role || (role !== "owner" && !allowed.includes(role))) {
      throw new ForbiddenError(
        "insufficient_org_role",
        "Your org role does not allow this action.",
      );
    }
    c.set("orgRole", role);
    await next();
  };
}

/** Read the org role stashed by requireOrgRole (present only after the guard has run). */
export function getOrgRole(c: Context<{ Variables: OrgRoleVariables }>): OrgRole {
  return c.get("orgRole");
}
