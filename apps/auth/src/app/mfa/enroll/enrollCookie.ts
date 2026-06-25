// enrollCookie.ts — the short-lived, HttpOnly, auth-origin cookie that carries ONE-TIME enrollment artefacts
// for the MID-LOGIN forced-enrollment screen (P1-01 sub-gate A): the freshly-generated TOTP secret (shown
// once for the QR / manual key) or the freshly-generated recovery codes (shown once). It is the login-flow
// analogue of /account/security/enroll's lw_acct_enroll cookie, but DISTINCT from it (different name) because
// this surface runs on the LOGIN TRANSACTION (the user proved their primary factor THIS flow but is not yet a
// durable session), not on an already-authenticated session. Kept in a plain (non-"use server") module so both
// the actions and the SSR page can share the name + the typed reader ("use server" files may only export async
// functions). HttpOnly + Secure + SameSite=Strict and DELETED on finish, which is what makes the display
// strictly one-time (09 secrets AC). It never holds a password and never appears in a URL/log.
import { cookies } from "next/headers";

export const MFA_ENROLL_COOKIE = "lw_mfa_enroll";
export const MFA_ENROLL_MAX_AGE = 300; // 5 min — long enough to scan a QR / copy codes, then it self-expires

export type MfaEnrollResult =
  | { kind: "totp"; secret: string }
  | { kind: "recovery"; codes: string[] };

/** Read + parse the enroll cookie, or null when absent/malformed. Does not clear it (finishEnroll does that). */
export async function readMfaEnrollResult(): Promise<MfaEnrollResult | null> {
  const raw = (await cookies()).get(MFA_ENROLL_COOKIE)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MfaEnrollResult;
    if (parsed.kind === "totp" && typeof parsed.secret === "string") return parsed;
    if (parsed.kind === "recovery" && Array.isArray(parsed.codes)) return parsed;
    return null;
  } catch {
    return null;
  }
}
