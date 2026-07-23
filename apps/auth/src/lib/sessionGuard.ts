// sessionGuard.ts — the server-side "already signed in?" guard for the auth-origin ENTRY pages (login, signup,
// forgot, reset, magic, sso). A visitor who already holds a live durable session (a valid lw_refresh cookie)
// must NOT be shown an auth form again — bounce them to the app, whose own shell gate silently refreshes them
// straight in. We validate the SAME way the refresh / logout / workspace-switch routes do
// (sessionRepository.findByRefreshTokenHash), so a merely-present cookie never counts as a valid session, and
// a revoked/expired one falls through to the form. Fails OPEN (renders the page) on any lookup error so a DB
// blip can never lock a legitimately-unauthenticated person out of signing in.
//
// Mid-flow steps (org / workspace / mfa / password) are deliberately NOT guarded: they run on the short-lived
// login-transaction cookie BEFORE a durable session exists and already bounce to /login without it.

import { readRefreshToken } from "@/lib/cookies";
import { hashRefreshToken } from "@leadwolf/auth";
import { appOrigins, env, isAllowedOrigin } from "@leadwolf/config";
import { sessionRepository } from "@leadwolf/db";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

/**
 * Redirect an already-authenticated visitor to the app and stop rendering the auth page. A no-op (returns, so
 * the page renders) when there is no live session. `appOriginHint` is the untrusted ?app_origin the flow
 * carries; it is honoured ONLY if it is an allow-listed app origin, otherwise we fall back to the default app
 * origin — a logged-in user is never redirected to an attacker-supplied location.
 */
export async function redirectIfAuthenticated(appOriginHint?: string): Promise<void> {
  const token = readRefreshToken(await cookies());
  if (!token) return; // no session cookie → definitely a guest; skip the DB lookup entirely

  let authenticated = false;
  try {
    const session = await sessionRepository.findByRefreshTokenHash(hashRefreshToken(token));
    authenticated = !!session && !session.revokedAt && session.expiresAt.getTime() > Date.now();
  } catch {
    // Fail OPEN: a DB hiccup must never block a legitimately-unauthenticated user from reaching sign-in.
    return;
  }
  if (!authenticated) return;

  // redirect() throws NEXT_REDIRECT, so it MUST run outside the try above (the catch would swallow it). Only
  // ever bounce to an allow-listed origin — the same guard that blocks the open-redirect / code-leak elsewhere.
  const target =
    appOriginHint && isAllowedOrigin(appOriginHint)
      ? appOriginHint
      : (env.NEXT_PUBLIC_APP_ORIGIN ?? appOrigins()[0]!);
  redirect(target);
}
