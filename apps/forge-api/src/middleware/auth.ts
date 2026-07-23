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

/** Scopes permitted to POST captures. Capture is the browser extension's job — its token carries
 *  scope:["extension"] (AUTH-065, apps/api extensionScope.ts). A general web/admin user token (scope:[]) must
 *  NOT be able to inject raw captures into the pipeline (P-01.15): the capture principal is SCOPED, not "any
 *  authenticated user". A finer-grained forge:capture scope is a future refinement once the mint issues one. */
const CAPTURE_SCOPES: ReadonlySet<string> = new Set(["extension"]);

/** The capture caller = the verified token's subject + tenant + whether it carries a capture scope (P-01.15).
 *  Only the extension/service credential is capture-scoped; the capture route 403s any non-capture-scoped token. */
export async function resolveCaller(
  c: Context,
): Promise<{ callerId: string; tenantId: string; captureScoped: boolean } | null> {
  const claims = await claimsFromRequest(c);
  if (!claims) return null;
  return {
    callerId: claims.sub,
    tenantId: claims.tid,
    captureScoped: claims.scope.some((s) => CAPTURE_SCOPES.has(s)),
  };
}
