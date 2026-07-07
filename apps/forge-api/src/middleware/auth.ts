// auth.ts — the Forge edge's authentication, swapped onto the EXISTING @leadwolf/auth (this is the whole point
// of re-homing: NO bespoke @forge/auth principal). Stateless: the API never issues tokens, it verifies the
// Bearer access token against auth.truepoint.in's JWKS (mirrors apps/api middleware/authn.ts). A missing/invalid
// token resolves to null and the route maps that to 401 with no detail leak. The operator/capture resolvers
// reuse the shipped platform-staff role → data:* capability system (staffCapability) — no new capability.
import { verifyAccessToken } from "@leadwolf/auth";
import { appOrigins } from "@leadwolf/config";
import { platformStaffRepository } from "@leadwolf/db";
import { type AccessTokenClaims, type StaffCapability, capabilitiesForRole } from "@leadwolf/types";
import type { Context } from "hono";
import type { Capability, StaffPrincipal } from "./capability.ts";

/** Extract + verify the Bearer access token; return its claims, or null on any failure (never leak which). */
export async function claimsFromRequest(c: Context): Promise<AccessTokenClaims | null> {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  try {
    // appOrigins already spans the app + extension origins (the ADR-0045 companion-window token audience).
    return await verifyAccessToken(token, [...appOrigins()]);
  } catch {
    return null; // invalid signature / issuer / audience / expiry — never leak which
  }
}

/** The closed data:* subset of the staff capability matrix this edge honours (13 §3). */
const DATA_CAPABILITIES: readonly Capability[] = [
  "data:read",
  "data:manage",
  "data:review",
  "data:export",
];
function toDataCapabilities(caps: StaffCapability[]): Capability[] {
  return caps.filter((cap): cap is Capability =>
    (DATA_CAPABILITIES as readonly string[]).includes(cap),
  );
}

/** The console operator = the verified token's subject + the data:* capabilities its ACTIVE staff role grants.
 *  Resolved per-request against platform_staff (owner-connection read) so a revoked grant takes effect at once;
 *  null if the caller is not active platform staff. Reuses the shipped data_ops → data:* bundle — no new cap. */
export async function resolveStaff(c: Context): Promise<StaffPrincipal | null> {
  const claims = await claimsFromRequest(c);
  if (!claims) return null;
  const role = await platformStaffRepository.getActiveRole(claims.sub);
  if (!role) return null;
  return {
    userId: claims.sub,
    capabilities: toDataCapabilities(capabilitiesForRole(role)),
    isSuperAdmin: role === "super_admin",
  };
}

/** The capture caller = the verified token's subject + tenant (the extension/service posting envelopes). */
export async function resolveCaller(
  c: Context,
): Promise<{ callerId: string; tenantId: string } | null> {
  const claims = await claimsFromRequest(c);
  return claims ? { callerId: claims.sub, tenantId: claims.tid } : null;
}
