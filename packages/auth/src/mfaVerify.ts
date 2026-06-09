// mfaVerify.ts — verify an MFA challenge during login: load the user's enrolled method, decrypt its secret,
// and check the code. TOTP is live; SMS/email OTP and recovery codes wire in with the M11 MFA depth (they
// need an OTP store + the recovery-code table). Returns whether the challenge passed. (17 §7.)

import { userRepository } from "@leadwolf/db";
import { verifyTotp } from "./mfa.ts";
import { decryptSecret } from "./secrets.ts";

export async function verifyMfaCode(input: {
  userId: string;
  method: string;
  code: string;
}): Promise<boolean> {
  const methods = await userRepository.listMfaMethods(input.userId);

  if (input.method === "totp") {
    const totp = methods.find((m) => m.type === "totp" && m.verifiedAt && m.secretEnc);
    if (!totp?.secretEnc) return false;
    return verifyTotp(decryptSecret(totp.secretEnc), input.code);
  }

  return false;
}
