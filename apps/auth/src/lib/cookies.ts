// cookies.ts — the auth-origin refresh cookie: HttpOnly · Secure · SameSite=Strict, scoped to the auth
// host only. Same-site (under truepoint.in) means it still rides app-initiated fetches to auth.* (17 §1).
import { env } from "@leadwolf/config";
import { cookies } from "next/headers";

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
// code_challenge, state) across the email round-trip until the verified link lands on /magic/confirm.
// Unlike the other transaction cookies this one is SameSite=Lax, NOT Strict: the magic link is a cross-site
// top-level navigation from the user's email client, and Strict cookies are dropped on those — Lax is the
// standard for email-link / OAuth-callback cookies. Still HttpOnly · Secure · auth-origin scoped, and it
// holds only PKCE/return context (the credential is the single-use code in the URL); 10-minute window.
export const MAGIC_TXN_COOKIE = "lw_magic_txn";
export const MAGIC_TXN_MAX_AGE = 600;

export async function setMagicTxnCookie(txnId: string): Promise<void> {
  (await cookies()).set(MAGIC_TXN_COOKIE, txnId, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
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
