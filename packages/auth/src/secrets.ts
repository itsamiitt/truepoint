// secrets.ts — symmetric encryption for at-rest secrets (TOTP/SMS/OIDC client secrets). AES-256-GCM with a
// key derived from config. Structured so it can be swapped for a KMS envelope in production WITHOUT changing
// callers (same encrypt/decrypt signature). Layout: iv(12) | authTag(16) | ciphertext.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "@leadwolf/config";

// Dev key derivation; production injects a dedicated KMS data key instead of reusing BLIND_INDEX_KEY.
const KEY = createHash("sha256").update(env.BLIND_INDEX_KEY).digest();

export function encryptSecret(plain: string): Uint8Array {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decryptSecret(blob: Uint8Array): string {
  const buf = Buffer.from(blob);
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
