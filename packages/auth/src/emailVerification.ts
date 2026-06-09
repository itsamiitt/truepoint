// emailVerification.ts — issues + checks the email-ownership proof used by registration (ADR-0020). A
// 6-digit code is emailed to the address; only its hash is persisted (auth_email_tokens), bound to the
// (purpose, email, code) tuple so codes can't be replayed across addresses. The raw code never touches the
// DB and is returned to the caller (apps/auth) solely to hand to the mailer. Delivery itself is the app's job.

import { createHash, randomInt } from "node:crypto";
import { authEmailTokenRepository } from "@leadwolf/db";

export type EmailTokenPurpose = "verify" | "magic_link" | "email_otp";

const TTL_MS = 15 * 60 * 1000; // 15-minute window to enter the code
const tokenHash = (purpose: EmailTokenPurpose, email: string, code: string): string =>
  createHash("sha256").update(`${purpose}:${email.toLowerCase()}:${code}`).digest("hex");

/** Mint a 6-digit email verification code, persist its hash, and return the raw code for delivery. */
export async function createEmailVerification(input: {
  email: string;
  userId?: string;
  purpose?: EmailTokenPurpose;
  ipAddress?: string;
}): Promise<{ code: string }> {
  const purpose = input.purpose ?? "verify";
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0"); // CSPRNG, zero-padded
  await authEmailTokenRepository.create({
    tokenHash: tokenHash(purpose, input.email, code),
    email: input.email.toLowerCase(),
    userId: input.userId,
    purpose,
    expiresAt: new Date(Date.now() + TTL_MS),
    ipAddress: input.ipAddress,
  });
  return { code };
}

/** Atomically consume a code: true only if it matches an unexpired, unconsumed token for that email. */
export async function verifyEmailCode(input: {
  email: string;
  code: string;
  purpose?: EmailTokenPurpose;
}): Promise<boolean> {
  const purpose = input.purpose ?? "verify";
  return authEmailTokenRepository.consume(tokenHash(purpose, input.email, input.code.trim()));
}
