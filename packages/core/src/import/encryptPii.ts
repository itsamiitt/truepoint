// encryptPii.ts — symmetric encryption for at-rest PII (email/phone), masked until reveal (03 §5, 08).
// AES-256-GCM with a key derived from config; layout iv(12) | authTag(16) | ciphertext. Same encrypt/decrypt
// signature as packages/auth/secrets.ts (which this deliberately mirrors) so production can swap in a KMS
// data key WITHOUT touching callers. It lives in `core` (not `auth`) because `core` must not import `auth`.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "@leadwolf/config";

// Dev key derivation; production injects a dedicated KMS data key instead of reusing BLIND_INDEX_KEY.
const KEY = createHash("sha256").update(env.BLIND_INDEX_KEY).digest();

export function encryptPii(plain: string): Uint8Array {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decryptPii(blob: Uint8Array): string {
  const buf = Buffer.from(blob);
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
