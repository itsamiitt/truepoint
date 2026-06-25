// passwordPolicy.ts — the single server-side password-acceptability gate (NIST SP 800-63B-4): length is the
// primary control, with NO composition/complexity rules and NO rotation; every new password is screened
// against the breached/common corpus (a SHALL in 800-63B-4). Called by every set-password path (registration,
// reset) so the client-side length hint is UX, not the boundary. https://pages.nist.gov/800-63-4/sp800-63b.html

import { isPasswordBreached } from "./breachCheck.ts";

export const PASSWORD_MIN_LENGTH = 12; // ≥ 8 is the SHALL; 12–15 recommended. A tenant policy may RAISE it (P1-01).
export const PASSWORD_MAX_LENGTH = 128; // accept long passphrases; cap only to bound Argon2 hashing cost.

export type PasswordRejection = "too_short" | "too_long" | "breached";

export function validatePasswordShape(password: string): PasswordRejection | null {
  if (password.length < PASSWORD_MIN_LENGTH) return "too_short";
  if (password.length > PASSWORD_MAX_LENGTH) return "too_long";
  return null; // NO composition/complexity rules by design (800-63B-4)
}

// Full gate: shape first (cheap, no network), then the breach screen (fail-open). Returns the rejection
// reason, or null when the password is acceptable.
export async function checkPasswordAcceptable(password: string): Promise<PasswordRejection | null> {
  const shape = validatePasswordShape(password);
  if (shape) return shape;
  if (await isPasswordBreached(password)) return "breached";
  return null;
}

export function passwordRejectionMessage(rejection: PasswordRejection): string {
  if (rejection === "too_short") return `Choose a password with at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (rejection === "too_long") return `Choose a password with at most ${PASSWORD_MAX_LENGTH} characters.`;
  return "That password has appeared in a known data breach. Choose a different one."; // "breached"
}
