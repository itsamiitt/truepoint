// apiKeySecret.ts — generate and hash a machine API credential (ADR-0049).
//
// In lib/ rather than inside a feature because TWO features need it and neither owns it: `api-keys` MINTS
// credentials, `public-api` VERIFIES them, and both must agree on the hash byte-for-byte or every key stops
// working. A copy in each slice is the version of this file that eventually drifts; a cross-feature import
// is what the boundary rule (correctly) refuses. Shared platform code is the third option and the right one.
//
// Its own module, and unit-tested, because the properties that matter here are exactly the ones that would
// pass code review while broken: a prefix that happened to be the whole secret, a hash that was the identity
// function, a "random" key that repeated.

import { createHash, randomBytes } from "node:crypto";
import { API_KEY_DISPLAY_PREFIX_LENGTH, API_KEY_LIVE_PREFIX } from "@leadwolf/types";

export interface MintedKey {
  /** The plaintext, returned to the user exactly once and never stored. */
  secret: string;
  /** SHA-256 hex of the secret — the only form that reaches the database. */
  keyHash: string;
  /** Non-secret display fragment for the management list. Never an authentication input. */
  keyPrefix: string;
}

export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/**
 * 32 bytes from the CSPRNG, base64url-encoded — 256 bits of entropy behind a `tp_live_` band. Not guessable,
 * so brute force is the rate limiter's problem rather than the key's.
 *
 * SHA-256 rather than Argon2/bcrypt is deliberate, and is the same choice `scim_tokens` made. A password
 * hash is slow ON PURPOSE because passwords are low-entropy and human-chosen; this value is neither — there
 * is no dictionary to attack and no user to protect from their own reuse — and the hash runs on every single
 * API request, where a deliberately-slow KDF would be a self-inflicted latency floor.
 */
export function mintKey(): MintedKey {
  const secret = `${API_KEY_LIVE_PREFIX}${randomBytes(32).toString("base64url")}`;
  return {
    secret,
    keyHash: sha256Hex(secret),
    keyPrefix: secret.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH),
  };
}
