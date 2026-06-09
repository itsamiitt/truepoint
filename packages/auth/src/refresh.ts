// refresh.ts — the silent-refresh primitive (ADR-0016): validate the presented refresh token, rotate the
// session (the old one is revoked → reuse-detection), and mint a fresh access JWT. All logic lives here so
// the route handler stays thin. Throws InvalidTokenError on any failure (unknown / expired / revoked).

import { env } from "@leadwolf/config";
import { sessionRepository, userRepository } from "@leadwolf/db";
import { InvalidTokenError } from "@leadwolf/types";
import { hashRefreshToken, rotateSession } from "./session.ts";
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
  const session = await sessionRepository.findByRefreshTokenHash(
    hashRefreshToken(args.presentedRefreshToken),
  );
  if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) {
    throw new InvalidTokenError();
  }

  const user = await userRepository.findById(session.userId);
  if (!user || user.status !== "active") throw new InvalidTokenError();

  const issued = await rotateSession(session.id, {
    userId: user.id,
    appOrigin: args.audience,
    deviceId: session.deviceId ?? undefined,
  });

  const { token, expiresIn } = await mintAccessToken({
    userId: user.id,
    tenantId: user.tenantId,
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
