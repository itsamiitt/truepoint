// mfaVerify.ts — verify an MFA challenge during login: load the user's enrolled method, decrypt its secret,
// and check the code. TOTP is live; SMS/email OTP and recovery codes wire in with the M11 MFA depth (they
// need an OTP store + the recovery-code table). Returns whether the challenge passed. (17 §7.)

import { userRepository } from "@leadwolf/db";
import { recordAuthMetric } from "./authMetrics.ts";
import { verifyTotp } from "./mfa.ts";
import { decryptSecret } from "./secrets.ts";

export async function verifyMfaCode(input: {
  userId: string;
  method: string;
  code: string;
}): Promise<boolean> {
  const methods = await userRepository.listMfaMethods(input.userId);

  let passed = false;
  if (input.method === "totp") {
    const totp = methods.find((m) => m.type === "totp" && m.verifiedAt && m.secretEnc);
    passed = totp?.secretEnc ? verifyTotp(decryptSecret(totp.secretEnc), input.code) : false;
  }

  // SLI: MFA challenge outcome (result-only enum; never the userId/method/code). "failed" also covers a code for
  // an unenrolled/unsupported method — a code that could not be verified did not pass.
  recordAuthMetric("auth_mfa_challenge_total", { result: passed ? "passed" : "failed" });
  return passed;
}
