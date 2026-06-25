// secretStore.ts — at-rest encryption for LIVE mailbox credentials (M12, email-planning/13 P0, D7,
// known-gap #1). AES-256-GCM with a VERSIONED envelope so a KMS-managed data key can be rotated without a
// data migration: layout = version(1) | iv(12) | authTag(16) | ciphertext. This mirrors core/import/encryptPii
// (same primitive) but is a DEDICATED store for third-party credentials — a different key, a versioned
// envelope, and a distinct module so a credential is never confused with prospect PII. The key comes from
// EMAIL_SECRET_KEY (the KMS-data-key target); in dev/test it falls back to deriving from BLIND_INDEX_KEY, the
// same dev-only posture encryptPii uses. The plaintext NEVER leaves the server and is NEVER logged.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "@leadwolf/config";

// Envelope version byte — lets a future KMS rotation introduce v2 ciphertext while v1 rows still decrypt.
const ENVELOPE_V1 = 0x01;

// Derive the 32-byte AES key. Production injects EMAIL_SECRET_KEY (a dedicated, rotated KMS data key);
// dev/test fall back to BLIND_INDEX_KEY so local flows work without extra config (encryptPii's posture).
const KEY = createHash("sha256")
  .update(env.EMAIL_SECRET_KEY ?? env.BLIND_INDEX_KEY)
  .digest();

/** Encrypt a credential string to the versioned envelope. Returns bytes ready for a `bytea` column. */
export function encryptSecret(plain: string): Uint8Array {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([ENVELOPE_V1]), iv, cipher.getAuthTag(), ct]);
}

/** Decrypt a versioned-envelope credential. Throws on an unknown version or a tampered tag (GCM auth). */
export function decryptSecret(blob: Uint8Array): string {
  const buf = Buffer.from(blob);
  const version = buf[0];
  if (version !== ENVELOPE_V1) {
    throw new Error(`secretStore: unsupported envelope version ${version}`);
  }
  const iv = buf.subarray(1, 13);
  const tag = buf.subarray(13, 29);
  const ct = buf.subarray(29);
  const decipher = createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
