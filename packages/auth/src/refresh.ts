// refresh.ts — the silent-refresh primitive (ADR-0016): validate the presented refresh token, rotate the
// session (the old one is revoked → reuse-detection), and mint a fresh access JWT. All logic lives here so
// the route handler stays thin. Throws InvalidTokenError on any failure (unknown / expired / revoked).

import { env } from "@leadwolf/config";
import { authPolicyRepository, userRepository } from "@leadwolf/db";
import { InvalidTokenError } from "@leadwolf/types";
import {
  findActiveSessionOrDetectReuse,
  isIdleExpired,
  revokeSession,
  rotateSession,
} from "./session.ts";
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

  // ── P1-01 Gate D — session-timeout enforcement on refresh (ADR-0018) ─────────────────────────────────
  // LOCKOUT-CAPABLE: enforced ONLY when BOTH the global env master-arm is the literal string "true" AND the
  // session's tenant has its per-tenant enforcement switch ON — either off = OFF = today's exact behavior (the
  // rotated session keeps the full default TTL, no idle check). The env check stays the OUTER guard so a
  // globally-disarmed deployment does no policy read.
  //
  // ABSOLUTE boundary: when the tenant policy sets sessionTimeoutSeconds, the rotation must not extend the
  // session past it — cap the rotated lifetime AND clamp it to the pre-rotation deadline (notLaterThan) so the
  // original cap is "sticky" across the ~14-min rotations. Once now passes that deadline,
  // findActiveSessionOrDetectReuse already rejects on expiresAt < now (session.ts) → force re-auth.
  //
  // IDLE boundary: when the tenant policy sets idleTimeoutSeconds, a refresh whose gap since the session's
  // lastSeenAt (stamped at create + every rotation, i.e. the last refresh) exceeds the idle window is rejected
  // and the session ended — independent of the absolute cap (idle resets on each refresh; absolute never
  // does). lastSeenAt null (a pre-column row) is treated as "no idle data" and never rejects. All timeouts
  // come from the RESOLVED tenant policy (server-side), never client input.
  let maxLifetimeSeconds: number | undefined;
  let notLaterThan: Date | undefined;
  if (env.AUTH_POLICY_ENFORCEMENT_ENABLED === "true") {
    const { policy, enforcementEnabled } = await authPolicyRepository.getForEnforcement(
      session.tenantId,
    );
    if (enforcementEnabled) {
      if (policy.sessionTimeoutSeconds != null && policy.sessionTimeoutSeconds > 0) {
        maxLifetimeSeconds = policy.sessionTimeoutSeconds;
        notLaterThan = session.expiresAt; // absolute deadline carried by the pre-rotation session
      }
      if (isIdleExpired(session.lastSeenAt, policy.idleTimeoutSeconds)) {
        // Idle past the window: end the session (revoke + deny-list its access token) and force re-auth.
        await revokeSession(session.id);
        throw new InvalidTokenError();
      }
    }
  }

  const issued = await rotateSession(session.id, {
    userId: user.id,
    tenantId: session.tenantId,
    workspaceId: session.workspaceId ?? undefined,
    appOrigin: args.audience,
    deviceId: session.deviceId ?? undefined,
    maxLifetimeSeconds,
    notLaterThan,
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
