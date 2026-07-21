// @forge/core blind index (08 §PII-minimizing, invariant 3). Silver carries HMAC(normalized channel value)
// only — never clear PII or ciphertext (§B). Runs server-side (parse worker), so node:crypto's SYNC HMAC
// keeps the parser a pure sync function. The dev key is deterministic (golden-fixture stability); production
// wraps the key with KMS (P0 §14).
import { createHmac } from "node:crypto";
import { BLIND_INDEX_KEY } from "@leadwolf/config";

/** Normalize an email to its canonical lowercased form before hashing. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** HMAC-SHA256(normalized) hex — the global dedup + DSAR/suppression key at the master layer (ecosystem-facts §B). */
export function blindIndex(normalized: string): string {
  return createHmac("sha256", BLIND_INDEX_KEY).update(normalized).digest("hex");
}
