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
//  • Uniform failure: a wrong credential and a lockout both return `false` — the caller shows one neutral error.
//  • An SSO-/passkey-only user has NO passwordHash. They still need to manage MFA, so step-up accepts EITHER
//    the current password (when one exists) OR a current TOTP code from an enrolled+verified authenticator —
//    so a passwordless user re-proves intent with the live second factor they already hold. A user with
//    neither a password nor a verified TOTP factor cannot step up (returns false): there is nothing to re-prove.

import { clientIpFromHeaders } from "@/lib/clientIp";
import {
  assertCredentialNotLocked,
  decryptSecret,
  recordCredentialFailure,
  recordCredentialSuccess,
  verifyPassword,
  verifyTotp,
} from "@leadwolf/auth";
import { type UserRecord, userRepository } from "@leadwolf/db";
import { headers } from "next/headers";

/**
 * Re-prove intent for `user` with the single submitted `credential`. Tries the current PASSWORD first (if the
 * user has one), then a current TOTP code from a verified authenticator (for SSO/passkey-only users who have no
 * password). Returns true only on a correct credential that is not rate-limited. Records the failure toward the
 * per-user lockout on a miss, and clears the counter on success. Never throws for a wrong credential (returns
 * false); infra errors inside the limiter fail open by design (rateLimit.ts). The TOTP secret is decrypted
 * server-side only (secrets.ts) and never leaves this process.
 */
export async function verifyStepUp(user: UserRecord, credential: string): Promise<boolean> {
  if (credential.length === 0) return false;

  const ip = clientIpFromHeaders(await headers());
  const key = `acct:${user.id}`;

  // The lockout wraps the WHOLE step-up (password OR TOTP) keyed per-user + IP, so neither branch can be used as
  // an offline-speed oracle — exactly as before, now covering the TOTP branch too.
  try {
    await assertCredentialNotLocked({ ip, identifier: key });
  } catch {
    return false; // locked out — uniform neutral failure (never reveal "locked" vs "wrong")
  }

  // 1) Password — the existing behavior when the user has a passwordHash.
  if (user.passwordHash) {
    if (await verifyPassword(user.passwordHash, credential)) {
      await recordCredentialSuccess(key);
      return true;
    }
    await recordCredentialFailure({ ip, identifier: key });
    return false;
  }

  // 2) No password (SSO/passkey-only) → re-prove a verified TOTP factor against the submitted code. listMfaMethods
  // already excludes recovery_code rows and returns the encrypted secret; a method only counts once verifiedAt is
  // set. Decrypt server-side and verify constant-time inside verifyTotp.
  const methods = await userRepository.listMfaMethods(user.id);
  const totp = methods.find((m) => m.type === "totp" && m.verifiedAt && m.secretEnc);
  if (totp?.secretEnc && verifyTotp(decryptSecret(totp.secretEnc), credential)) {
    await recordCredentialSuccess(key);
    return true;
  }

  // No password AND (no verified TOTP OR wrong code) — record the failure toward the lockout and fail uniformly.
  await recordCredentialFailure({ ip, identifier: key });
  return false;
}
