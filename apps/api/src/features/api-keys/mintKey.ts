// mintKey.ts — generate a machine API credential (ADR-0049). Its own module so it can be tested without a
// database or a Hono context: the properties that matter here (entropy, that the stored hash is not the
// secret, that the displayed prefix is not enough to authenticate with) are exactly the ones nobody notices
// breaking.

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
 * so the brute-force surface is the rate limiter's problem and not the key's.
 *
 * SHA-256 rather than Argon2/bcrypt is deliberate and is the same choice scim_tokens made: a password hash is
 * slow ON PURPOSE because passwords are low-entropy and human-chosen. This value is neither — there is no
 * dictionary to attack and no user to protect from their own reuse — and the hash runs on every single API
 * request, where a deliberately-slow KDF would be a self-inflicted latency floor.
 */
export function mintKey(): MintedKey {
  const secret = `${API_KEY_LIVE_PREFIX}${randomBytes(32).toString("base64url")}`;
  return {
    secret,
    keyHash: sha256Hex(secret),
    keyPrefix: secret.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH),
  };
}
