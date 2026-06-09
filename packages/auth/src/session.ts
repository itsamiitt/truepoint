// session.ts — durable session lifecycle on the auth origin (Lucia-style, 17 §5): mint a session id + an
// opaque refresh token, persist ONLY the token hash, and rotate with reuse-detection. The raw refresh
// token is returned once (to set the auth-origin cookie) and never stored or logged.

import { createHash, randomBytes } from "node:crypto";
import { env } from "@leadwolf/config";
import { sessionRepository } from "@leadwolf/db";

const newId = () => randomBytes(24).toString("base64url");
export const hashRefreshToken = (t: string): string =>
  createHash("sha256").update(t).digest("hex");
const refreshExpiry = () => new Date(Date.now() + env.REFRESH_TOKEN_TTL_SECONDS * 1000);

export interface IssuedSession {
  sessionId: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface SessionContext {
  userId: string;
  appOrigin?: string;
  deviceId?: string;
  ipAddress?: string;
  userAgent?: string;
}

export async function createSession(ctx: SessionContext): Promise<IssuedSession> {
  const sessionId = newId();
  const refreshToken = randomBytes(32).toString("base64url");
  const expiresAt = refreshExpiry();
  await sessionRepository.create({
    id: sessionId,
    userId: ctx.userId,
    refreshTokenHash: hashRefreshToken(refreshToken),
    expiresAt,
    appOrigin: ctx.appOrigin,
    deviceId: ctx.deviceId,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return { sessionId, refreshToken, expiresAt };
}

/** Rotate: revoke the old session and issue a fresh one in the same family (reuse-detection upstream). */
export async function rotateSession(
  oldSessionId: string,
  ctx: SessionContext,
): Promise<IssuedSession> {
  const sessionId = newId();
  const refreshToken = randomBytes(32).toString("base64url");
  const expiresAt = refreshExpiry();
  await sessionRepository.rotate({
    oldId: oldSessionId,
    next: {
      id: sessionId,
      userId: ctx.userId,
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresAt,
      appOrigin: ctx.appOrigin,
      deviceId: ctx.deviceId,
    },
  });
  return { sessionId, refreshToken, expiresAt };
}

export const revokeSession = (sessionId: string): Promise<void> => sessionRepository.revoke(sessionId);
