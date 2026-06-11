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
