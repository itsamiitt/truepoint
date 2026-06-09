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

// The short-lived signup-transaction cookie that threads registration (email → verify → profile) until the
// identity is created. Same hardening as the login-transaction cookie; 15-minute window (matches the email code).
export const SIGNUP_TXN_COOKIE = "lw_signup_txn";
export const SIGNUP_TXN_MAX_AGE = 900;

// The short-lived SSO-transaction cookie that threads the handoff → IdP → callback round-trip together
// (carries the relay-state CSRF binding). Same hardening; 10-minute window to complete the IdP exchange.
export const SSO_TXN_COOKIE = "lw_sso_txn";
export const SSO_TXN_MAX_AGE = 600;
