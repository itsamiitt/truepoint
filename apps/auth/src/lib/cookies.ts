// cookies.ts — the auth-origin refresh cookie: HttpOnly · Secure · SameSite=Strict, scoped to the auth
// host only. Same-site (under truepoint.in) means it still rides app-initiated fetches to auth.* (17 §1).
import { cookies } from "next/headers";
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

// The short-lived magic-link-transaction cookie that carries the app's PKCE/return context (app_origin,
// code_challenge, state) across the email round-trip until the verified link lands on /verify. Same
// hardening as the other transaction cookies (HttpOnly · Secure · SameSite=Strict, auth-origin scoped);
// 10-minute window to click the link. Helpers below mirror the inline set/read/clear used for the others.
export const MAGIC_TXN_COOKIE = "lw_magic_txn";
export const MAGIC_TXN_MAX_AGE = 600;

export async function setMagicTxnCookie(txnId: string): Promise<void> {
  (await cookies()).set(MAGIC_TXN_COOKIE, txnId, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: MAGIC_TXN_MAX_AGE,
  });
}

export async function readMagicTxnCookie(): Promise<string | undefined> {
  return (await cookies()).get(MAGIC_TXN_COOKIE)?.value;
}

export async function clearMagicTxnCookie(): Promise<void> {
  (await cookies()).delete(MAGIC_TXN_COOKIE);
}
