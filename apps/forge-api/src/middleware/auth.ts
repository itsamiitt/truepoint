// auth.ts — the Forge edge's authentication, swapped onto the EXISTING @leadwolf/auth (this is the whole point
// of re-homing: NO bespoke @forge/auth principal). Stateless: the API never issues tokens, it verifies the
// Bearer access token against auth.truepoint.in's JWKS (mirrors apps/api middleware/authn.ts). A missing/invalid
// token resolves to null and the route maps that to 401 with no detail leak. The operator/capture resolvers
// reuse the shipped platform-staff role → data:* capability system (staffCapability) — no new capability.
import { verifyAccessToken } from "@leadwolf/auth";
import { appOrigins, env } from "@leadwolf/config";
import { platformStaffRepository } from "@leadwolf/db";
import { type AccessTokenClaims, type StaffCapability, capabilitiesForRole } from "@leadwolf/types";
import type { Context } from "hono";
import type { Capability, StaffPrincipal } from "./capability.ts";

/** Extract + verify the Bearer access token against an EXPLICIT audience list; null on any failure.
 *
 *  The audience list is a parameter, not a constant, because the two principals this file resolves accept
 *  different credentials: capture legitimately accepts the extension's token, staff must not. Passing
 *  `appOrigins()` (which unions EXTENSION_ORIGINS) to a staff route is precisely the hole fixed below. */
async function claimsForAudience(
  c: Context,
  audiences: readonly string[],
): Promise<AccessTokenClaims | null> {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  try {
    return await verifyAccessToken(token, [...audiences]);
  } catch {
    return null; // invalid signature / issuer / audience / expiry — never leak which
  }
}

/** Verify against the app + extension origins (the ADR-0045 companion-window token audience). Capture only. */
export async function claimsFromRequest(c: Context): Promise<AccessTokenClaims | null> {
  return claimsForAudience(c, appOrigins());
}

/** The scope an /auth/extension/mint token carries (AUTH-065). Duplicated as a literal rather than imported:
 *  it lives in apps/api, and `apps-never-import-apps` (dependency-cruiser) forbids reaching across. It is a
 *  wire constant — if it ever changes, both copies must change. */
const EXTENSION_SCOPE = "extension";

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
  // TWO gates, deliberately redundant. Previously this verified against appOrigins() — which unions
  // EXTENSION_ORIGINS — and applied no scope check, so an extension-minted token belonging to a data_ops
  // staffer authenticated the entire staff surface: every /bff/* cross-tenant read AND the review/approve
  // promotion write. apps/api's extension-scope confinement (extensionScope.ts) is apps/api middleware and
  // does not run on this edge, so nothing else was stopping it.
  //   1. Audience: APP_ORIGINS only. An extension-audience token no longer verifies here at all.
  //   2. Scope: reject scope:["extension"] even on an app-audience token, so a future mint that widens the
  //      audience cannot silently re-open this.
  const claims = await claimsForAudience(c, env.APP_ORIGINS);
  if (!claims) return null;
  if (claims.scope.includes(EXTENSION_SCOPE)) return null;
  const role = await platformStaffRepository.getActiveRole(claims.sub);
  if (!role) return null;
  return {
    userId: claims.sub,
    capabilities: toDataCapabilities(capabilitiesForRole(role)),
    staffRole: role,
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
