// cookies.ts — the auth-origin refresh cookie: HttpOnly · Secure · SameSite=Strict, scoped to the auth
// host only. Same-site (under truepoint.in) means it still rides app-initiated fetches to auth.* (17 §1).
import { env } from "@leadwolf/config";
import { cookies } from "next/headers";

export const REFRESH_COOKIE = "lw_refresh";

// AUTH-074 — the `__Host-` refresh cookie. The prefix is browser-ENFORCED host-only scope: Secure + Path=/ +
// NO Domain. Our cookie is already host-only (Domain === the auth host), so this hardens the guarantee at the
// browser rather than trusting the AUTH_COOKIE_DOMAIN config. Migration is staged READERS-FIRST: this window
// ships the dual-READ (accept both names, host-preferred) so every instance can read the new cookie BEFORE any
// instance writes it; a later window flips the WRITE to this name (and clears both). Deploying reader+writer
// together would leave a window where a new-writer node sets a cookie an old-reader node can't read.
export const REFRESH_COOKIE_HOST = "__Host-lw_refresh";

/** Dual-read the refresh token from a Next `cookies()` jar — prefer the __Host- cookie, fall back to the legacy
 *  name during the migration window. */
export function readRefreshToken(jar: {
  get(name: string): { value: string } | undefined;
}): string | undefined {
  return jar.get(REFRESH_COOKIE_HOST)?.value ?? jar.get(REFRESH_COOKIE)?.value;
}

/** Dual-read the refresh token from a raw `Cookie` request header (route handlers) — same host-preferred
 *  fallback. Returns the value, or null if neither cookie is present. */
export function readRefreshTokenFromHeader(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  let legacy: string | null = null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === REFRESH_COOKIE_HOST) return v.join("="); // host cookie wins if both are somehow present
    if (k === REFRESH_COOKIE) legacy = v.join("=");
  }
  return legacy;
}

/** Whether writers currently emit the `__Host-` cookie (AUTH-074 stage 2; env-gated, default off). */
export const refreshCookieWritesHost = (): boolean => env.REFRESH_COOKIE_HOST_WRITE === "true";

/** The refresh-cookie NAME writers should use now (host cookie when the write flip is armed, else legacy). */
export const refreshCookieName = (): string =>
  refreshCookieWritesHost() ? REFRESH_COOKIE_HOST : REFRESH_COOKIE;

/** PURE Set-Cookie builder — `__Host-` forbids Domain (browser-enforced host-only); the legacy cookie keeps its
 *  host-scoped Domain. Extracted so the name/attribute wiring is unit-testable without env. */
export function buildRefreshSetCookie(
  useHost: boolean,
  token: string,
  maxAgeSeconds: number,
  domain: string,
): string {
  const parts = [
    `${useHost ? REFRESH_COOKIE_HOST : REFRESH_COOKIE}=${token}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/",
  ];
  if (!useHost) parts.push(`Domain=${domain}`);
  parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join("; ");
}

/** PURE clear builder — clears BOTH names so logout ends a session set under either, whichever the write flip
 *  was on for. Clearing an absent cookie is a harmless browser no-op. */
export function buildClearRefreshCookies(domain: string): string[] {
  return [
    `${REFRESH_COOKIE_HOST}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
    `${REFRESH_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Domain=${domain}; Max-Age=0`,
  ];
}

export function refreshCookie(token: string, maxAgeSeconds: number): string {
  return buildRefreshSetCookie(
    refreshCookieWritesHost(),
    token,
    maxAgeSeconds,
    env.AUTH_COOKIE_DOMAIN,
  );
}

/** Clear the refresh cookie(s) — returns BOTH Set-Cookie directives; the caller appends each to its response. */
export function clearRefreshCookie(): string[] {
  return buildClearRefreshCookies(env.AUTH_COOKIE_DOMAIN);
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
