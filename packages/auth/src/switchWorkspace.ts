// switchWorkspace.ts — the authenticated workspace-switch primitive (ADR-0019): validate the presented
// refresh token, authorize the target workspace (active membership WITHIN the session's tenant — never a
// cross-tenant jump; tenant switching is out of scope), re-pin the session's active workspace, rotate the
// session (the old one is revoked → reuse-rejection, not family revocation), and mint a fresh access JWT carrying the new wid. All
// logic lives here so the route handler stays thin. Throws InvalidTokenError on auth failure, ForbiddenError
// when the user has no active role on the target workspace (or it is cross-tenant).

import { env } from "@leadwolf/config";
import { sessionRepository, userRepository, workspaceRepository } from "@leadwolf/db";
import { ForbiddenError, InvalidTokenError } from "@leadwolf/types";
import { hashRefreshToken, rotateSession } from "./session.ts";
import { mintAccessToken } from "./token.ts";

export interface SwitchWorkspaceResult {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshMaxAge: number;
}

export async function switchWorkspace(args: {
  presentedRefreshToken: string;
  targetWorkspaceId: string;
  audience: string; // the requesting app origin
}): Promise<SwitchWorkspaceResult> {
  const session = await sessionRepository.findByRefreshTokenHash(
    hashRefreshToken(args.presentedRefreshToken),
  );
  if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) {
    throw new InvalidTokenError();
  }

  const user = await userRepository.findById(session.userId);
  if (!user || user.status !== "active") throw new InvalidTokenError();

  if (!session.tenantId) throw new InvalidTokenError();

  // AUTHZ: the target must be a workspace the user actively belongs to, WITHIN the session's tenant. The
  // role read is scoped to session.tenantId, so a workspace in another tenant simply yields no membership
  // here — there is no path to escalate across tenants (tenant switching is deliberately out of scope).
  const role = await workspaceRepository.getRoleForUser(
    session.tenantId,
    args.targetWorkspaceId,
    user.id,
  );
  if (!role) throw new ForbiddenError("workspace_forbidden");

  await sessionRepository.setWorkspace(session.id, args.targetWorkspaceId);
  const issued = await rotateSession(session.id, {
    userId: user.id,
    tenantId: session.tenantId,
    workspaceId: args.targetWorkspaceId,
    appOrigin: args.audience,
    deviceId: session.deviceId ?? undefined,
  });

  const { token, expiresIn } = await mintAccessToken({
    userId: user.id,
    tenantId: session.tenantId,
    workspaceId: args.targetWorkspaceId,
    sessionId: issued.sessionId,
    audience: args.audience,
  });

  return {
    accessToken: token,
    expiresIn,
    refreshToken: issued.refreshToken,
    refreshMaxAge: env.REFRESH_TOKEN_TTL_SECONDS,
  };
}
