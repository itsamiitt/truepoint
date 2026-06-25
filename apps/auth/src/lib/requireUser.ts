// requireUser.ts — the authenticated-user gate for the /account/security self-service surface (P1-02). The
// account pages run AFTER login on the auth origin (where the durable session + refresh cookie live, ADR-0016),
// so — unlike the mid-login steps, which key off the short-lived login-transaction cookie — they resolve the
// CURRENT signed-in person from the SAME durable-session lookup the refresh / logout / sessionGuard routes use
// (sessionRepository.findByRefreshTokenHash on the hashed lw_refresh cookie). A merely-present cookie never
// counts: the session must be unrevoked and unexpired, exactly as findActiveSessionOrDetectReuse requires.
//
// SECURITY (09 access / mass-assignment AC): this returns the userId + sessionId taken ONLY from the verified
// session. Every /account/security read and write scopes itself to THIS userId — never an id from the request
// body or query — so a user can only ever manage their own account. There is no "act on behalf of user X" path
// here. A missing/invalid session redirects to /login (no account surface is rendered to a guest).
//
// CSRF (09 "Auth-origin cookie routes are CSRF-defended"): the actions that gate on this authenticate off the
// lw_refresh cookie, which is SameSite=Strict (lib/cookies.ts) — a cross-site form post cannot send it, so it
// can never ride a session into a mutation; requireUser then redirects to /login. Next server actions add an
// Origin/action-id check on top, and every mutation additionally requires step-up (current password). Three
// independent layers, no relaxation of the existing cookie hardening.

import { REFRESH_COOKIE } from "@/lib/cookies";
import { hashRefreshToken } from "@leadwolf/auth";
import { type UserRecord, sessionRepository, userRepository } from "@leadwolf/db";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export interface AuthenticatedAccount {
  /** The signed-in person — the ONLY user id any /account/security action is allowed to act on. */
  userId: string;
  /** This browser's current durable session id — used to mark "this device" and to revoke-OTHERS safely. */
  sessionId: string;
  /** The active org of the current session (may be null — a user can have 0/>1 orgs; ADR-0019). */
  tenantId: string | null;
  /** The active workspace of the current session (null until one is selected). */
  workspaceId: string | null;
  /** The full identity record (email, passwordHash for step-up, status). Never expose passwordHash to the UI. */
  user: UserRecord;
}

/**
 * Resolve the authenticated account from the durable refresh cookie, or `redirect("/login")` when there is no
 * live session. Fails CLOSED for the account surface: any missing/revoked/expired session, or a vanished user,
 * bounces to sign-in (the opposite stance to redirectIfAuthenticated, which fails OPEN for the *entry* pages).
 */
export async function requireUser(): Promise<AuthenticatedAccount> {
  const token = (await cookies()).get(REFRESH_COOKIE)?.value;
  if (!token) redirect("/login");

  const session = await sessionRepository.findByRefreshTokenHash(hashRefreshToken(token));
  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
    redirect("/login");
  }

  const user = await userRepository.findById(session.userId);
  if (!user || user.status !== "active") redirect("/login");

  return {
    userId: session.userId,
    sessionId: session.id,
    tenantId: session.tenantId,
    workspaceId: session.workspaceId,
    user,
  };
}
