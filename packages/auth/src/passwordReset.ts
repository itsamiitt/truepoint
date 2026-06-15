// passwordReset.ts — thin orchestration over the existing email-token + password primitives for the
// /forgot → /reset flow (17 §9). requestPasswordReset is ENUMERATION-SAFE: it returns the same neutral
// shape whether or not the account exists, so the caller's UX can never distinguish them; the raw reset
// code is returned ONLY when the user exists, and solely to hand to the mailer (never logged, never an
// error). completePasswordReset consumes the single-use, short-lived reset token (TTL is the shared
// email-token window) and replaces the Argon2id digest. Tokens never appear in returned errors.

import { userRepository } from "@leadwolf/db";
import { createEmailVerification, verifyEmailCode } from "./emailVerification.ts";
import { hashPassword } from "./password.ts";

export interface RequestPasswordResetInput {
  email: string;
  ipAddress?: string;
}

// Neutral by design: `sent` is always true regardless of existence (no enumeration). `code` is present only
// when an account exists, for the caller to email — the caller MUST NOT branch its UX on its presence.
export interface RequestPasswordResetResult {
  sent: true;
  code?: string;
}

export async function requestPasswordReset(
  input: RequestPasswordResetInput,
): Promise<RequestPasswordResetResult> {
  const email = input.email.trim().toLowerCase();
  const user = await userRepository.findByEmail(email);

  // TODO(amit, 2026-06-15): emit password.reset.* audit events when the auth audit sink lands.
  if (!user) return { sent: true }; // enumeration-safe: identical shape to the success path

  const { code } = await createEmailVerification({
    email,
    userId: user.id,
    purpose: "reset",
    ipAddress: input.ipAddress,
  });
  return { sent: true, code };
}

export interface CompletePasswordResetInput {
  email: string;
  code: string;
  newPassword: string;
}

// Discriminated result mirroring the auth error `code` vocabulary (errors.ts): a bad/expired/replayed
// reset code maps to `invalid_token`. The submitted code is never echoed back in the failure.
export type CompletePasswordResetResult =
  | { ok: true; userId: string }
  | { ok: false; code: "invalid_token" };

export async function completePasswordReset(
  input: CompletePasswordResetInput,
): Promise<CompletePasswordResetResult> {
  const email = input.email.trim().toLowerCase();
  const consumed = await verifyEmailCode({ email, code: input.code, purpose: "reset" });
  if (!consumed) return { ok: false, code: "invalid_token" }; // single-use token expired/replayed/wrong

  const user = await userRepository.findByEmail(email);
  if (!user) return { ok: false, code: "invalid_token" }; // token matched but identity vanished (edge)

  const passwordHash = await hashPassword(input.newPassword);
  await userRepository.setPassword(user.id, passwordHash);

  // TODO(amit, 2026-06-15): emit password.reset.* audit events when the auth audit sink lands.
  return { ok: true, userId: user.id };
}
