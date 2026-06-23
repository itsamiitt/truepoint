// refresh.ts — the silent-refresh primitive (ADR-0016): validate the presented refresh token, rotate the
// session (the old one is revoked → reuse-detection), and mint a fresh access JWT. All logic lives here so
// the route handler stays thin. Throws InvalidTokenError on any failure (unknown / expired / revoked).

import { env } from "@leadwolf/config";
import { userRepository } from "@leadwolf/db";
import { InvalidTokenError } from "@leadwolf/types";
import { findActiveSessionOrDetectReuse, rotateSession } from "./session.ts";
import { mintAccessToken } from "./token.ts";

export interface RefreshResult {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshMaxAge: number;
}

export async function refreshAccessToken(args: {
  presentedRefreshToken: string;
  audience: string; // the requesting app origin
}): Promise<RefreshResult> {
  // Validate the presented token + detect reuse: a REVOKED token presented here is a replay of a captured
  // value (the browser always sends the latest cookie), which revokes the whole session family (W10/#8).
  const session = await findActiveSessionOrDetectReuse(args.presentedRefreshToken);

  const user = await userRepository.findById(session.userId);
  if (!user || user.status !== "active") throw new InvalidTokenError();

  if (!session.tenantId) throw new InvalidTokenError();
  const issued = await rotateSession(session.id, {
    userId: user.id,
    tenantId: session.tenantId,
    workspaceId: session.workspaceId ?? undefined,
    appOrigin: args.audience,
    deviceId: session.deviceId ?? undefined,
  });

  const { token, expiresIn } = await mintAccessToken({
    userId: user.id,
    tenantId: session.tenantId,
    workspaceId: session.workspaceId ?? undefined,
    sessionId: issued.sessionId,
    audience: args.audience,
    // Carry the platform super-admin flag across the silent refresh (ADR-0032): the `pa` claim is minted at
    // finalizeLogin but the 15-min access token is re-minted here ~every 14 min — without this the staff
    // console would 403 the admin on the first refresh. `user` is already loaded + status-checked above.
    isPlatformAdmin: user.isPlatformAdmin ?? false,
  });

  return {
    accessToken: token,
    expiresIn,
    refreshToken: issued.refreshToken,
    refreshMaxAge: env.REFRESH_TOKEN_TTL_SECONDS,
  };
}
