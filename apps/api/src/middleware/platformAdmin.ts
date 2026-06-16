// platformAdmin.ts — authorize a route to platform super-admins ONLY (ADR-0032). Runs AFTER authn; gates on
// the signed `pa` claim. Platform-admin routes are NOT workspace-scoped (no tenancy middleware) — the caller
// reads across all tenants via the audited withPlatformTx path. Denies by default: anything without
// pa===true → 403. The flag is server-set and rides the signed JWT, so it cannot be forged by the request.
import { ForbiddenError } from "@leadwolf/types";
import type { Context, Next } from "hono";
import type { ApiVariables } from "./authn.ts";

export async function platformAdmin(
  c: Context<{ Variables: ApiVariables }>,
  next: Next,
): Promise<void> {
  const claims = c.get("claims");
  if (claims?.pa !== true) {
    throw new ForbiddenError("not_platform_admin", "Platform admin access required.");
  }
  await next();
}
