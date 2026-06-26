// session.ts — durable session lifecycle on the auth origin (Lucia-style, 17 §5): mint a session id + an
// opaque refresh token, persist ONLY the token hash, and rotate with reuse-detection. The raw refresh
// token is returned once (to set the auth-origin cookie) and never stored or logged.

import { createHash, randomBytes } from "node:crypto";
import { env } from "@leadwolf/config";
import { sessionRepository } from "@leadwolf/db";
import { InvalidTokenError } from "@leadwolf/types";
import { markManyRevoked, markRevoked } from "./revocation.ts";

const newId = () => randomBytes(24).toString("base64url");
export const hashRefreshToken = (t: string): string => createHash("sha256").update(t).digest("hex");

// ── P1-01 Gate D — session-timeout cap (ADR-0018) ──────────────────────────────────────────────────────
// A tenant policy's sessionTimeoutSeconds is an ABSOLUTE cap on session lifetime: the session expires at the
// EARLIER of the platform default (REFRESH_TOKEN_TTL_SECONDS) and now + sessionTimeoutSeconds. This is the
// absolute boundary; an IDLE boundary (expire after N seconds of inactivity, tracked via lastSeenAt) is a
// DEFERRED follow-up — lastSeenAt is not surfaced on the refresh read path yet (see refresh.ts). Pure +
// db-free so the cap math is unit-testable. The caller (finalizeLogin) only supplies maxLifetimeSeconds when
// AUTH_POLICY_ENFORCEMENT_ENABLED === "true", so with the flag OFF this returns the unchanged default expiry.
export function cappedSessionExpiry(maxLifetimeSeconds?: number, now: number = Date.now()): Date {
  const defaultExpiryMs = now + env.REFRESH_TOKEN_TTL_SECONDS * 1000;
  if (maxLifetimeSeconds == null || maxLifetimeSeconds <= 0) return new Date(defaultExpiryMs);
  const policyExpiryMs = now + maxLifetimeSeconds * 1000;
  return new Date(Math.min(defaultExpiryMs, policyExpiryMs));
}

// ── P1-01 Gate D — IDLE boundary (ADR-0018) ────────────────────────────────────────────────────────────
// True when a session has been idle longer than the tenant policy's idle window — the SECOND, independent
// timeout boundary alongside the absolute cap above. The anchor is the session's lastSeenAt, stamped `now` at
// create and on every refresh rotation (so it tracks the last refresh); the refresh path consults this and,
// when expired, ends the session and forces re-auth. Idle RESETS on each refresh; the absolute cap never
// does. Pure + db-free so the boundary is unit-testable. Fails SAFE (never idle-expired) when: the window is
// unset / non-positive (no idle limit configured), or lastSeenAt is null (a pre-column row — no idle data, so
// we never lock a user out over data we do not have). The caller only invokes this when enforcement is active.
export function isIdleExpired(
  lastSeenAt: Date | null,
  idleTimeoutSeconds?: number,
  now: number = Date.now(),
): boolean {
  if (idleTimeoutSeconds == null || idleTimeoutSeconds <= 0) return false;
  if (lastSeenAt == null) return false;
  return now - lastSeenAt.getTime() > idleTimeoutSeconds * 1000;
}

export interface IssuedSession {
  sessionId: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface SessionContext {
  userId: string;
  tenantId?: string;
  workspaceId?: string;
  appOrigin?: string;
  deviceId?: string;
  ipAddress?: string;
  userAgent?: string;
  // P1-01 Gate D: ABSOLUTE cap (seconds) on this session's lifetime from the resolved tenant policy. Only
  // supplied by finalizeLogin when AUTH_POLICY_ENFORCEMENT_ENABLED === "true"; undefined → unchanged default
  // expiry. Capped via cappedSessionExpiry(min(default, now + cap)).
  maxLifetimeSeconds?: number;
  // P1-01 Gate D (rotation): an existing absolute deadline the rotated session must NOT be extended beyond.
  // refresh.ts passes the pre-rotation session's expiresAt here when enforcement is on, so the original capped
  // deadline stays "sticky" across the ~14-min refresh rotations instead of resetting to a fresh full TTL —
  // making the existing `expiresAt < now` reject in findActiveSessionOrDetectReuse the absolute-cap force-
  // re-auth point. Undefined → unchanged rotation lifetime.
  notLaterThan?: Date;
}

export async function createSession(ctx: SessionContext): Promise<IssuedSession> {
  const sessionId = newId();
  const refreshToken = randomBytes(32).toString("base64url");
  const expiresAt = cappedSessionExpiry(ctx.maxLifetimeSeconds);
  await sessionRepository.create({
    id: sessionId,
    userId: ctx.userId,
    tenantId: ctx.tenantId,
    workspaceId: ctx.workspaceId,
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
  // P1-01 Gate D: the rotated session is capped to min(default | policy cap, the pre-rotation deadline). With
  // the flag off both maxLifetimeSeconds and notLaterThan are undefined, so this is exactly the default TTL
  // (cappedSessionExpiry(undefined) === now + REFRESH_TOKEN_TTL_SECONDS), unchanged from before.
  const capped = cappedSessionExpiry(ctx.maxLifetimeSeconds);
  const expiresAt =
    ctx.notLaterThan != null && ctx.notLaterThan.getTime() < capped.getTime()
      ? ctx.notLaterThan
      : capped;
  await sessionRepository.rotate({
    oldId: oldSessionId,
    next: {
      id: sessionId,
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresAt,
      appOrigin: ctx.appOrigin,
      deviceId: ctx.deviceId,
    },
  });
  // Deny-list the OLD session id so its still-unexpired access token stops working immediately, not 15 min
  // from now — closes the post-switch "old token keeps the old workspace scope" window (W5/W4).
  await markRevoked(oldSessionId);
  return { sessionId, refreshToken, expiresAt };
}

/** Revoke a single session AND deny-list its access token so logout takes effect within seconds (17 §5). */
export async function revokeSession(sessionId: string): Promise<void> {
  await sessionRepository.revoke(sessionId);
  await markRevoked(sessionId);
}

/** Global force-logout: revoke EVERY session of a user and deny-list each token (password change/reset, W6). */
export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  const ids = await sessionRepository.revokeAllForUser(userId);
  await markManyRevoked(ids);
}

type ActiveSession = NonNullable<
  Awaited<ReturnType<typeof sessionRepository.findByRefreshTokenHash>>
>;

// Refresh-token reuse detection (W10/#8, ADR-0016). Rotation revokes the previous token and the browser always
// sends the LATEST cookie, so a valid client never presents a revoked one. A revoked token presented well after
// its rotation is therefore a replay of a captured/stolen value → revoke the WHOLE family (every active session
// of the user) so neither the thief nor the victim keeps access; the victim simply re-authenticates. A
// near-instant re-presentation is a benign concurrent-refresh race across the rotation boundary (two requests
// read the same cookie a few ms apart); a short grace window suppresses that false positive.
const REUSE_GRACE_MS = 30_000;

/**
 * Resolve the ACTIVE session for a presented refresh token, or throw InvalidTokenError — detecting and
 * punishing token reuse. Used by every refresh-cookie consumer (silent refresh, workspace switch, org switch)
 * so reuse detection is enforced uniformly in one place.
 */
export async function findActiveSessionOrDetectReuse(
  presentedRefreshToken: string,
): Promise<ActiveSession> {
  const session = await sessionRepository.findByRefreshTokenHash(
    hashRefreshToken(presentedRefreshToken),
  );
  if (!session) throw new InvalidTokenError();
  if (session.revokedAt) {
    // A revoked token was presented: a benign rotation race inside the grace window, else a reuse attack →
    // family revocation. Either way the presented token is rejected.
    if (Date.now() - session.revokedAt.getTime() > REUSE_GRACE_MS) {
      await revokeAllSessionsForUser(session.userId);
    }
    throw new InvalidTokenError();
  }
  if (session.expiresAt.getTime() < Date.now()) throw new InvalidTokenError();
  return session;
}
