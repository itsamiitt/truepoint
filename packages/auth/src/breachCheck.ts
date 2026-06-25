// breachCheck.ts — screen a candidate password against the HaveIBeenPwned "Pwned Passwords" corpus using the
// k-ANONYMITY range API: the password and its full SHA-1 NEVER leave the process — only the first 5 hex chars
// of the hash are sent, and the returned suffixes are matched locally
// (https://haveibeenpwned.com/API/v3#PwnedPasswords). FAIL-OPEN: a HIBP outage/timeout must never block account
// creation or a password reset (availability over this single screening control; same posture as the
// rate-limiter). The host is a FIXED constant — never tenant-supplied, so this is not an SSRF surface.

import { createHash } from "node:crypto";

const HIBP_RANGE = "https://api.pwnedpasswords.com/range/";
const TIMEOUT_MS = 1500;

export async function isPasswordBreached(password: string): Promise<boolean> {
  const sha1 = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${HIBP_RANGE}${prefix}`, {
      headers: { "Add-Padding": "true" }, // padding hides the real match count from a network observer
      signal: controller.signal,
    });
    if (!res.ok) return false; // fail-open: a non-200 (incl. rate-limit) must not block the password set
    const body = await res.text();
    for (const line of body.split("\n")) {
      if (line.split(":")[0]?.trim().toUpperCase() === suffix) return true;
    }
    return false;
  } catch {
    return false; // fail-open on timeout / network error
  } finally {
    clearTimeout(timer);
  }
}
