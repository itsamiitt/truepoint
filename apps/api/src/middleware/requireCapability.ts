// requireCapability.ts — authorize a platform (cross-tenant) staff route by the caller's granular CAPABILITY
// (13a F3, ADR-0011 / 13 §2), the capability-matrix layer over requireStaffRole. Composes AFTER authn +
// platformAdmin (the coarse `pa` gate): it resolves the ACTIVE role from platform_staff (an owner-connection
// read — the table denies the app role) and rejects 403 unless the role grants EVERY listed capability.
// super_admin implies all. Resolved per-request, so a revoked/changed grant takes effect immediately. This is
// This is now the ONLY staff-authz guard: audit 32 · C8 migrated every endpoint off requireStaffRole and
// deleted it, so there is one system rather than two interchangeable ones that could drift apart.

import { platformStaffRepository } from "@leadwolf/db";
import {
  ForbiddenError,
  type StaffCapability,
  type StaffRole,
  roleHasCapability,
} from "@leadwolf/types";
import type { Context, MiddlewareHandler } from "hono";
import type { ApiVariables } from "./authn.ts";

/**
 * The staff role this guard stashes for handlers. Declared HERE since audit 32 · C8 retired
 * requireStaffRole: the guard that sets a context variable should own its type.
 */
export type StaffRoleVariables = ApiVariables & { staffRole: StaffRole };

/** Guard a platform-admin route to callers whose staff role grants ALL of the given capabilities. */
export function requireCapability(...required: StaffCapability[]): MiddlewareHandler {
  return async (c, next) => {
    const claims = c.get("claims");
    const role = await platformStaffRepository.getActiveRole(claims.sub);
    if (!role || !required.every((cap) => roleHasCapability(role, cap))) {
      throw new ForbiddenError(
        "insufficient_capability",
        "Your staff role does not grant the capability for this action.",
      );
    }
    c.set("staffRole", role);
    await next();
  };
}

/** Read the staff role stashed by requireCapability (present only after the guard has run). */
export function getStaffRole(c: Context<{ Variables: StaffRoleVariables }>) {
  return c.get("staffRole");
}
