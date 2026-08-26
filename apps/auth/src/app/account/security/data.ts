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

/**
 * Rows each session table on /account/security renders. The page is SSR with no pagination control (these are
 * plain server-rendered tables, not the DS DataTable — see auth.module.css), so whatever this returns is
 * whatever the browser is sent: an account with a long device history would otherwise stream every row into
 * the HTML. Twenty is the page; the count line below tells the user what is hidden.
 */
export const SECURITY_LIST_PAGE_SIZE = 20;

/**
 * Rows the underlying read loads — `sessionRepository.listOwnSessionsDetailed`'s own default cap, named here
 * because the totals below are measured against it. When the read comes back full the totals are a FLOOR, not
 * an exact figure, which is why `atSourceLimit` travels with them rather than the page claiming a number it
 * cannot know.
 */
const SOURCE_ROW_LIMIT = 50;

export interface AccountSecurityData {
  hasPassword: boolean;
  mfaMethods: MfaMethodView[];
  recoveryCodesRemaining: number;
  /** The most recent `SECURITY_LIST_PAGE_SIZE` live sessions. */
  activeSessions: SessionView[];
  /** Recent sessions (active + revoked/expired) as the login-history view, same cap. */
  loginHistory: SessionView[];
  /** Unclipped counts for the two lists above, so the page can say how many rows it is NOT showing. */
  activeSessionsTotal: number;
  loginHistoryTotal: number;
  /** True when the source read filled its cap, making both totals a floor ("50+") rather than exact. */
  atSourceLimit: boolean;
}

/**
 * Copy for the honest "you are not seeing all of them" line under a capped table; null when nothing is hidden.
 * Lives beside the page size on purpose — the cap and the sentence that discloses it have to move together.
 */
export function moreRowsNote(shown: number, total: number, atSourceLimit: boolean): string | null {
  if (total <= shown) return null;
  return `Showing the ${shown} most recent of ${total}${atSourceLimit ? "+" : ""}.`;
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

  // The repository orders `created_at DESC`, so the head of each list IS "the most recent" — no re-sort here.
  return {
    hasPassword: !!user?.passwordHash,
    mfaMethods: detailed,
    recoveryCodesRemaining: recoveryCount,
    activeSessions: active.slice(0, SECURITY_LIST_PAGE_SIZE).map(toView),
    loginHistory: sessions.slice(0, SECURITY_LIST_PAGE_SIZE).map(toView),
    activeSessionsTotal: active.length,
    loginHistoryTotal: sessions.length,
    atSourceLimit: sessions.length >= SOURCE_ROW_LIMIT,
  };
}
