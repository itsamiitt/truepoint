// requireStaffRole.ts — authorize a PLATFORM (cross-tenant) staff route by the caller's granular staff role
// (ADR-0011). Composes AFTER authn + platformAdmin (the coarse `pa` gate): it resolves the ACTIVE role from
// platform_staff (an owner-connection read — the table denies the app role) and rejects 403 when the caller
// has no active staff role or it is not allowed. `super_admin` implies every staff capability. Resolved
// per-request, so a revoked grant takes effect immediately (no stale-JWT window).

import { platformStaffRepository } from "@leadwolf/db";
import { ForbiddenError, type StaffRole } from "@leadwolf/types";
import type { Context, MiddlewareHandler } from "hono";
import type { ApiVariables } from "./authn.ts";

export type StaffRoleVariables = ApiVariables & { staffRole: StaffRole };

/** Guard a platform-admin route to the given staff roles. `super_admin` always passes (implies all). */
export function requireStaffRole(...allowed: StaffRole[]): MiddlewareHandler {
  return async (c, next) => {
    const claims = c.get("claims");
    const role = await platformStaffRepository.getActiveRole(claims.sub);
    if (!role || (role !== "super_admin" && !allowed.includes(role))) {
      throw new ForbiddenError(
        "insufficient_staff_role",
        "Your staff role does not allow this action.",
      );
    }
    c.set("staffRole", role);
    await next();
  };
}

/** Read the staff role stashed by requireStaffRole (present only after the guard has run). */
export function getStaffRole(c: Context<{ Variables: StaffRoleVariables }>): StaffRole {
  return c.get("staffRole");
}
