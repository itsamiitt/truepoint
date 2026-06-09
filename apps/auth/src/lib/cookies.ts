// cookies.ts — the auth-origin refresh cookie: HttpOnly · Secure · SameSite=Strict, scoped to the auth
// host only. Same-site (under truepoint.in) means it still rides app-initiated fetches to auth.* (17 §1).
import { env } from "@leadwolf/config";

export const REFRESH_COOKIE = "lw_refresh";

export function refreshCookie(token: string, maxAgeSeconds: number): string {
  return [
    `${REFRESH_COOKIE}=${token}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/",
    `Domain=${env.AUTH_COOKIE_DOMAIN}`,
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

export function clearRefreshCookie(): string {
  return `${REFRESH_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Domain=${env.AUTH_COOKIE_DOMAIN}; Max-Age=0`;
}

// The short-lived login-transaction cookie (auth-origin, HttpOnly, SameSite=Strict) that threads the
// multi-step flow (password → MFA → workspace) together until completion.
export const LOGIN_TXN_COOKIE = "lw_login_txn";
export const LOGIN_TXN_MAX_AGE = 600;
