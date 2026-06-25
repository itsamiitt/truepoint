// stepUp.ts — the shared re-authentication (step-up) gate for every STATE-CHANGING /account/security action
// (09 threat-model "MFA integrity": step-up before enroll/disable/regenerate; and the password-change re-auth).
// Re-proving the CURRENT password is the second-factor-of-intent: it stops a drive-by CSRF/clickjack or a
// walked-up unlocked session from silently changing a security setting, and binds the change to someone who
// holds the live credential — not merely a live cookie.
//
// SECURITY:
//  • Identity is the authenticated session's userId (passed in by the caller from requireUser) — NEVER a
//    request value, so step-up can only ever re-prove the signed-in person (09 access AC).
//  • Brute-force: every attempt runs under the credential lockout limiter, keyed `acct:<userId>` + IP, so the
//    re-auth prompt cannot be used as an offline-speed password oracle (09 MFA-integrity "rate-limit" AC).
//  • Uniform failure: a wrong password and a lockout both return `false` — the caller shows one neutral error.
//  • An SSO-/passkey-only user has no passwordHash; step-up via password is unavailable and returns false
//    (CONFIRM: a passwordless step-up path — re-prove an existing MFA factor — is a follow-up; see report).

import { clientIpFromHeaders } from "@/lib/clientIp";
import {
  assertCredentialNotLocked,
  recordCredentialFailure,
  recordCredentialSuccess,
  verifyPassword,
} from "@leadwolf/auth";
import type { UserRecord } from "@leadwolf/db";
import { headers } from "next/headers";

/**
 * Re-prove the current password for `user`. Returns true only on a correct password that is not rate-limited.
 * Records the failure toward the lockout on a miss, and clears the counter on success. Never throws for a
 * wrong password (returns false); infra errors inside the limiter fail open by design (rateLimit.ts).
 */
export async function verifyStepUp(user: UserRecord, currentPassword: string): Promise<boolean> {
  if (!user.passwordHash || currentPassword.length === 0) return false;

  const ip = clientIpFromHeaders(await headers());
  const key = `acct:${user.id}`;

  try {
    await assertCredentialNotLocked({ ip, identifier: key });
  } catch {
    return false; // locked out — uniform neutral failure (never reveal "locked" vs "wrong")
  }

  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    await recordCredentialFailure({ ip, identifier: key });
    return false;
  }
  await recordCredentialSuccess(key);
  return true;
}
