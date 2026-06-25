// enrollCookie.ts — the short-lived, HttpOnly, auth-origin cookie that carries ONE-TIME enrollment artefacts
// between the enroll server actions and the /account/security/enroll result render: the freshly-generated TOTP
// secret (shown once for the QR / manual key) or the freshly-generated recovery codes (shown once). Kept in a
// plain (non-"use server") module so BOTH the actions and the SSR page can share the name + the typed reader
// ("use server" files may only export async functions). The cookie is HttpOnly + Secure + SameSite=Strict and
// is DELETED on finish, which is what makes the display strictly one-time (09 secrets AC). It never holds a
// password and never appears in a URL/log.
import { cookies } from "next/headers";

export const ENROLL_RESULT_COOKIE = "lw_acct_enroll";
export const ENROLL_RESULT_MAX_AGE = 300; // 5 min — long enough to scan a QR / copy codes, then it self-expires

export type EnrollResult =
  | { kind: "totp"; secret: string }
  | { kind: "recovery"; codes: string[] };

/** Read + parse the enroll cookie, or null when absent/malformed. Does not clear it (finishEnroll does that). */
export async function readEnrollResult(): Promise<EnrollResult | null> {
  const raw = (await cookies()).get(ENROLL_RESULT_COOKIE)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as EnrollResult;
    if (parsed.kind === "totp" && typeof parsed.secret === "string") return parsed;
    if (parsed.kind === "recovery" && Array.isArray(parsed.codes)) return parsed;
    return null;
  } catch {
    return null;
  }
}
