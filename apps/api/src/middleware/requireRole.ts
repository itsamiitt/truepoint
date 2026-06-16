// requireRole.ts — authorize a workspace-scoped route by the caller's active workspace role (17 §5). Runs
// AFTER authn+tenancy: it reads the verified claims + the resolved tenant/workspace, looks the role up via
// the workspaces repository (RLS-scoped), and rejects with a 403 Problem when no workspace is selected, the
// caller is not an active member, or the role is not allowed. On success the role is stashed for handlers.

import { workspaceRepository } from "@leadwolf/db";
import { ForbiddenError, type WorkspaceRole } from "@leadwolf/types";
import type { Context, MiddlewareHandler } from "hono";
import type { TenancyVariables } from "./tenancy.ts";

export type RoleVariables = TenancyVariables & { role: WorkspaceRole };

/** Guard a route to the given workspace roles, resolving the role from the active workspace membership. */
export function requireRole(...allowed: WorkspaceRole[]): MiddlewareHandler {
  return async (c, next) => {
    const claims = c.get("claims");
    const tenantId = c.get("tenantId") as string;
    const workspaceId = c.get("workspaceId") as string | undefined;
    if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to continue.");

    const role = await workspaceRepository.getRoleForUser(tenantId, workspaceId, claims.sub);
    if (!role || !allowed.includes(role)) {
      throw new ForbiddenError("insufficient_role", "Your role does not allow this action.");
    }
    c.set("role", role);
    await next();
  };
}

/** Read the workspace role stashed by requireRole (present only after the guard has run). */
export function getWorkspaceRole(c: Context<{ Variables: RoleVariables }>): WorkspaceRole {
  return c.get("role");
}
