// mfaVerify.ts — verify an MFA challenge during login: load the user's enrolled method, decrypt its secret,
// and check the code. TOTP is live; SMS/email OTP and recovery codes wire in with the M11 MFA depth (they
// need an OTP store + the recovery-code table). Returns whether the challenge passed. (17 §7.)

import { userRepository } from "@leadwolf/db";
import { recordAuthMetric } from "./authMetrics.ts";
import { createEmailVerification, verifyEmailCode } from "./emailVerification.ts";
import { verifyTotp } from "./mfa.ts";
import { decryptSecret } from "./secrets.ts";

export async function verifyMfaCode(input: {
  userId: string;
  method: string;
  code: string;
}): Promise<boolean> {
  const passed = await checkMfaCode(input);
  // SLI: MFA challenge outcome (result-only enum; never the userId/method/code). "failed" also covers a code for
  // an unenrolled/unsupported method — a code that could not be verified did not pass.
  recordAuthMetric("auth_mfa_challenge_total", { result: passed ? "passed" : "failed" });
  return passed;
}

async function checkMfaCode(input: {
  userId: string;
  method: string;
  code: string;
}): Promise<boolean> {
  // Email OTP (AUTH-025): no enrolled secret — the factor is the 6-digit code emailed to the user's VERIFIED
  // address, checked against the auth_email_tokens store (purpose "email_otp", atomic single-use + TTL). Inert
  // until the MFA flow offers "email_otp" as a challenge method, so this is additive to the TOTP path.
  if (input.method === "email_otp") {
    const user = await userRepository.findById(input.userId);
    if (!user?.email) return false;
    return verifyEmailCode({ email: user.email, code: input.code, purpose: "email_otp" });
  }
  if (input.method === "totp") {
    const methods = await userRepository.listMfaMethods(input.userId);
    const totp = methods.find((m) => m.type === "totp" && m.verifiedAt && m.secretEnc);
    return totp?.secretEnc ? verifyTotp(decryptSecret(totp.secretEnc), input.code) : false;
  }
  return false;
}

/**
 * Request an email-OTP MFA challenge (AUTH-025): mint a 6-digit code for the user's verified email and return it
 * (plus the address, for a "sent to a•••@b.com" hint) so the caller — apps/auth — delivers it via the auth
 * mailer. Reuses the shared auth_email_tokens store (only the code HASH is persisted). Returns null when the
 * user or their email is absent. The mailer/rate-limit + the MFA-flow wiring that offers this method are the
 * app-layer follow-up; this primitive is inert until then.
 */
export async function requestEmailOtp(
  userId: string,
): Promise<{ email: string; code: string } | null> {
  const user = await userRepository.findById(userId);
  if (!user?.email) return null;
  const { code } = await createEmailVerification({
    email: user.email,
    userId,
    purpose: "email_otp",
  });
  return { email: user.email, code };
}
