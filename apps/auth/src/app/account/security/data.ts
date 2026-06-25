// data.ts — server-side read models for the /account/security SSR page. Every read is scoped to the
// authenticated `userId` (passed from requireUser), never a request value (09 access AC). Pure shaping over the
// repositories — no mutation here. Recovery codes are summarised as a count only (the plaintext is shown once,
// at generation, and is never re-derivable from the stored hashes).

import { sessionRepository, userRepository } from "@leadwolf/db";

export interface MfaMethodView {
  id: string;
  type: string;
  label: string | null;
  verifiedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface SessionView {
  id: string;
  /** True for the session backing THIS browser (the durable refresh cookie) — never offered for revoke. */
  current: boolean;
  device: string;
  ipAddress: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  expiresAt: Date;
}

export interface AccountSecurityData {
  hasPassword: boolean;
  mfaMethods: MfaMethodView[];
  recoveryCodesRemaining: number;
  activeSessions: SessionView[];
  /** Recent sessions (active + revoked/expired) as the login-history view. */
  loginHistory: SessionView[];
}

// A coarse, dependency-free device label from the stored User-Agent. There is no ua-parser in the repo and
// pulling one in for a status line is not worth a new dependency; this covers the common platforms and falls
// back to "Unknown device" — purely cosmetic, never a security control.
export function deviceLabelFromUa(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Mac OS X|Macintosh/.test(ua)
      ? "macOS"
      : /Android/.test(ua)
        ? "Android"
        : /iPhone|iPad|iOS/.test(ua)
          ? "iOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "Unknown OS";
  return `${browser} on ${os}`;
}

/**
 * Load everything the /account/security page renders for `userId`. `currentSessionId` (from requireUser) marks
 * "this device". Device/IP/last-seen come straight off the user's OWN `user_sessions` rows (captured at login).
 */
export async function loadAccountSecurity(
  userId: string,
  currentSessionId: string,
): Promise<AccountSecurityData> {
  const [user, detailed, recoveryCount, sessions] = await Promise.all([
    userRepository.findById(userId),
    userRepository.listMfaMethodsDetailed(userId),
    userRepository.countRecoveryCodes(userId),
    sessionRepository.listOwnSessionsDetailed(userId),
  ]);

  const now = Date.now();
  const toView = (s: (typeof sessions)[number]): SessionView => ({
    id: s.id,
    current: s.id === currentSessionId,
    device: deviceLabelFromUa(s.userAgent),
    ipAddress: s.ipAddress,
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    expiresAt: s.expiresAt,
  });

  const active = sessions.filter((s) => !s.revokedAt && s.expiresAt.getTime() > now);

  return {
    hasPassword: !!user?.passwordHash,
    mfaMethods: detailed,
    recoveryCodesRemaining: recoveryCount,
    activeSessions: active.map(toView),
    loginHistory: sessions.slice(0, 20).map(toView),
  };
}
