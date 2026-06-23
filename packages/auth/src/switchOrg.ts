// switchOrg.ts — the authenticated ORG (tenant) switch primitive (ADR-0019 follow-up, Issue 2b): a multi-org
// user moves their active session to a DIFFERENT tenant they belong to WITHOUT logging out. Validates the
// presented refresh token, AUTHORIZES active membership in the target tenant (the minted `tid` drives the RLS
// GUC, so this is THE cross-tenant boundary — a forged tenantId must be impossible), lands them on that
// tenant's remembered/default/first workspace, rotates the session (old one revoked + deny-listed), and mints a
// fresh access JWT carrying the new tid/wid (+ pa). Throws InvalidTokenError on auth failure, ForbiddenError
// when the user is not an active member of the target tenant.

import { env } from "@leadwolf/config";
import { tenantMemberRepository, userRepository, workspaceRepository } from "@leadwolf/db";
import { ForbiddenError, InvalidTokenError } from "@leadwolf/types";
import { findActiveSessionOrDetectReuse, rotateSession } from "./session.ts";
import { mintAccessToken } from "./token.ts";

export interface SwitchOrgResult {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshMaxAge: number;
}

export async function switchOrg(args: {
  presentedRefreshToken: string;
  targetTenantId: string;
  audience: string; // the requesting app origin
}): Promise<SwitchOrgResult> {
  const session = await findActiveSessionOrDetectReuse(args.presentedRefreshToken);

  const user = await userRepository.findById(session.userId);
  if (!user || user.status !== "active") throw new InvalidTokenError();

  // AUTHZ: the target tenant MUST be an active membership of this user. The minted JWT's `tid` sets the RLS
  // GUC for every downstream query, so an unauthorized tenant here would be a cross-tenant breach — this
  // membership check IS the boundary for the org switch (mirrors switchWorkspace's workspace check).
  const orgs = await tenantMemberRepository.listForUser(user.id);
  if (!orgs.some((o) => o.tenantId === args.targetTenantId)) {
    throw new ForbiddenError("tenant_forbidden");
  }

  // Land on the target org's remembered / default / first workspace. May be undefined when the user belongs to
  // the org but to no workspace in it — the session is then workspace-less until they pick one (same as a fresh
  // login into such an org), never a cross-tenant leak.
  const workspaceId =
    (await workspaceRepository.resolveLandingWorkspace(args.targetTenantId, user.id)) ?? undefined;
  if (workspaceId) {
    await tenantMemberRepository.setLastWorkspace(args.targetTenantId, user.id, workspaceId);
  }

  // Rotate into a session pinned to the NEW tenant + workspace. rotateSession revokes + deny-lists the old
  // session id, so the previous (old-tenant) access token stops working immediately, not at its 15-min expiry.
  const issued = await rotateSession(session.id, {
    userId: user.id,
    tenantId: args.targetTenantId,
    workspaceId,
    appOrigin: args.audience,
    deviceId: session.deviceId ?? undefined,
  });

  const { token, expiresIn } = await mintAccessToken({
    userId: user.id,
    tenantId: args.targetTenantId,
    workspaceId,
    sessionId: issued.sessionId,
    audience: args.audience,
    isPlatformAdmin: user.isPlatformAdmin ?? false,
  });

  return {
    accessToken: token,
    expiresIn,
    refreshToken: issued.refreshToken,
    refreshMaxAge: env.REFRESH_TOKEN_TTL_SECONDS,
  };
}
