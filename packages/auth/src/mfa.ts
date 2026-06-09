// mfa.ts — TOTP verification (ADR-0010 via @oslojs/otp) + recovery-code matching. Constant-time compares;
// secrets/codes are never logged. SMS/email OTP and WebAuthn enrollment land with the M11 MFA depth.

import { createHash, timingSafeEqual } from "node:crypto";
import { decodeBase32 } from "@oslojs/encoding";
import { verifyTOTP } from "@oslojs/otp";

const PERIOD_SECONDS = 30;
const DIGITS = 6;

/** Verify a 6-digit TOTP against a base32-encoded secret. */
export function verifyTotp(secretBase32: string, code: string): boolean {
  try {
    const key = decodeBase32(secretBase32);
    return verifyTOTP(key, PERIOD_SECONDS, DIGITS, code.trim());
  } catch {
    return false;
  }
}

const hashCode = (code: string): string => createHash("sha256").update(code.trim()).digest("hex");

/** Return the matching stored recovery-code hash (single-use; caller marks it consumed), or null. */
export function matchRecoveryCode(input: string, storedHashes: readonly string[]): string | null {
  const candidate = Buffer.from(hashCode(input), "hex");
  for (const stored of storedHashes) {
    const buf = Buffer.from(stored, "hex");
    if (buf.length === candidate.length && timingSafeEqual(buf, candidate)) return stored;
  }
  return null;
}
