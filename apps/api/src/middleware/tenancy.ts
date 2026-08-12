// tenancy.ts — derive tenant/workspace from the VERIFIED claims (never from the request body, 09 §1) so
// repositories can open a withTenantTx-scoped transaction. The RLS GUCs themselves are set in the db layer.

import { ForbiddenError } from "@leadwolf/types";
import type { Context, Next } from "hono";
import type { ApiVariables } from "./authn.ts";

export type TenancyVariables = ApiVariables & { tenantId: string; workspaceId: string | undefined };

export async function tenancy(
  c: Context<{ Variables: TenancyVariables }>,
  next: Next,
): Promise<void> {
  const claims = c.get("claims");
  if (!claims?.tid) throw new ForbiddenError("no_tenant");
  c.set("tenantId", claims.tid);
  c.set("workspaceId", claims.wid);
  await next();
}

/**
 * Narrow the optional workspace to a required one, or refuse.
 *
 * `tenancy` resolves `workspaceId` from the token, but a caller can hold a valid session with no workspace
 * selected — so every workspace-scoped handler has to narrow `string | undefined` to `string` before it can
 * do anything. That produced 127 copies of the same two lines across 39 route files, and FIVE separate local
 * `requireWorkspace` helpers with two incompatible signatures (some take the Context, some take the value).
 * One helper, one signature.
 *
 * `message` is a parameter rather than a constant because the good ones are route-specific — "Select a
 * workspace before revealing" tells a user what they were trying to do, and flattening every site to one
 * generic string would be a small UX regression in exchange for tidiness.
 *
 * NOTE ON REDUNDANCY: a route already behind `requireRole` cannot reach a handler without a workspace —
 * that guard throws the same error first. The call here is then purely for TYPE NARROWING, which is why it
 * stays rather than being deleted as dead.
 */
export function requireWorkspace(
  c: { get: (k: "workspaceId") => string | undefined },
  message = "Select a workspace to continue.",
): string {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", message);
  return workspaceId;
}
