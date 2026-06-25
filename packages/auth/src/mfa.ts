// mfa.ts — TOTP verification + GENERATION (ADR-0010 via @oslojs/otp) + recovery-code matching/generation.
// Constant-time compares; secrets/codes are never logged. SMS/email OTP and WebAuthn enrollment land with the
// M11 MFA depth. The generation half (P1-02) is what the /account/security TOTP-enroll flow needs: a fresh
// CSPRNG base32 secret, the otpauth:// provisioning URI for the QR, and one-time recovery codes (shown once,
// stored hashed). The new secret is bound to the authenticated user by the CALLER (it persists under the
// session's userId) — this module never receives a request-supplied user id (09 MFA-integrity AC).

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
// VERIFIED against @oslojs/encoding published source: `encodeBase32NoPadding(bytes: Uint8Array): string` is a
// present (deprecated-but-exported) symbol in 1.1.0, and `decodeBase32(encoded: string): Uint8Array` matches the
// existing usage. (node_modules is not installed in this sandbox; signatures confirmed from the library source.)
import { decodeBase32, encodeBase32NoPadding } from "@oslojs/encoding";
// VERIFIED against @oslojs/otp published source: `createTOTPKeyURI(issuer: string, accountName: string,
// key: Uint8Array, periodInSeconds: number, digits: number): string` and `verifyTOTP(key: Uint8Array,
// intervalInSeconds: number, digits: number, otp: string): boolean` — both call sites below match exactly.
import { createTOTPKeyURI, verifyTOTP } from "@oslojs/otp";

const PERIOD_SECONDS = 30;
const DIGITS = 6;
const SECRET_BYTES = 20; // 160-bit TOTP secret (RFC 6238 / RFC 4226 recommended minimum)

/** Verify a 6-digit TOTP against a base32-encoded secret. */
export function verifyTotp(secretBase32: string, code: string): boolean {
  try {
    const key = decodeBase32(secretBase32);
    return verifyTOTP(key, PERIOD_SECONDS, DIGITS, code.trim());
  } catch {
    return false;
  }
}

/**
 * Generate a fresh TOTP secret (CSPRNG, 160-bit) as an unpadded base32 string — the format `decodeBase32`
 * round-trips and authenticator apps expect. The caller encrypts it (secrets.ts) before it ever touches the
 * DB; the plaintext only leaves the server once, to render the QR + manual-entry key at enrollment.
 */
export function generateTotpSecret(): string {
  return encodeBase32NoPadding(randomBytes(SECRET_BYTES));
}

/**
 * Build the `otpauth://totp/...` provisioning URI for a secret, for the QR / manual-entry display. `issuer`
 * is the product brand ("TruePoint"); `accountName` is the user's email (the authenticator label). No secret
 * is logged — this string is rendered into the page only and never persisted.
 */
export function totpKeyUri(
  secretBase32: string,
  accountName: string,
  issuer = "TruePoint",
): string {
  const key = decodeBase32(secretBase32);
  return createTOTPKeyURI(issuer, accountName, key, PERIOD_SECONDS, DIGITS);
}

const hashCode = (code: string): string => createHash("sha256").update(code.trim()).digest("hex");

/** SHA-256 hash of a recovery code, as bytea, for at-rest storage (one-way; never reversible). */
export function hashRecoveryCode(code: string): Uint8Array {
  return createHash("sha256").update(code.trim()).digest();
}

// Recovery-code alphabet: unambiguous (no 0/O, 1/I/L) so a user can transcribe a printed code without error.
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_GROUP = 5; // formatted as XXXXX-XXXXX

/** Generate `count` human-friendly one-time recovery codes (shown once, then stored only as hashes). */
export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    let raw = "";
    for (let c = 0; c < RECOVERY_GROUP * 2; c++) {
      raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    }
    codes.push(`${raw.slice(0, RECOVERY_GROUP)}-${raw.slice(RECOVERY_GROUP)}`);
  }
  return codes;
}

/** Return the matching stored recovery-code hash (single-use; caller marks it consumed), or null. */
export function matchRecoveryCode(input: string, storedHashes: readonly string[]): string | null {
  const candidate = Buffer.from(hashCode(input), "hex");
  for (const stored of storedHashes) {
    const buf = Buffer.from(stored, "hex");
    if (buf.length === candidate.length && timingSafeEqual(buf, candidate)) return stored;
  }
  return null;
}
