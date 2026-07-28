// crmSecretStore.ts — at-rest encryption for third-party CRM credentials (crm-sync 00 §5.3 / §7.2).
// AES-256-GCM with a VERSIONED envelope so a KMS-managed data key can be rotated without a data migration:
// layout = version(1) | iv(12) | authTag(16) | ciphertext.
//
// WHY A THIRD STORE. This is byte-identical in shape to core/email/secretStore, and that duplication is the
// point rather than an oversight: each credential class gets its own module and its own key (truepoint-
// security secrets). Sharing the email key would mean one compromised key exposes mailbox tokens AND CRM
// tokens, and a rotation forced by one incident would have to re-encrypt the other. A CRM refresh token is
// also a far broader capability than a mailbox token — it can read and write a customer's entire system of
// record — so it gets its own blast radius.
//
// The key comes from CRM_SECRET_KEY (the KMS-data-key target); in dev/test it falls back to deriving from
// BLIND_INDEX_KEY, the same dev-only posture the email store and encryptPii use.
//
// > IMPLEMENTATION STATUS: sha256(env) is a DEV-GRADE derivation, not a KMS. 00 §7.2/§11 makes a real
// > CMK-wrapped data key the security-owned hard prerequisite BEFORE any production CRM token is stored.
// > The envelope's version byte is the seam that makes that swap additive: v2 ciphertext can use a
// > KMS-wrapped DEK while every v1 row still decrypts.
//
// The plaintext bundle NEVER leaves the server, is NEVER logged, and is NEVER projected into a DTO — the
// repository's safeColumns omits the ciphertext column and only the worker that calls the CRM decrypts it.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "@leadwolf/config";
import type { CrmTokenBundle } from "./port.ts";

// Envelope version byte — lets a future KMS rotation introduce v2 ciphertext while v1 rows still decrypt.
const ENVELOPE_V1 = 0x01;

// Derive the 32-byte AES key. Production injects CRM_SECRET_KEY (a dedicated, rotated KMS data key);
// dev/test fall back to BLIND_INDEX_KEY so local flows work without extra config.
const KEY = createHash("sha256")
  .update(env.CRM_SECRET_KEY ?? env.BLIND_INDEX_KEY)
  .digest();

/** Encrypt a credential string to the versioned envelope. Returns bytes ready for a `bytea` column. */
export function encryptCrmSecret(plain: string): Uint8Array {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([ENVELOPE_V1]), iv, cipher.getAuthTag(), ct]);
}

/** Decrypt a versioned-envelope credential. Throws on an unknown version or a tampered tag (GCM auth). */
export function decryptCrmSecret(blob: Uint8Array): string {
  const buf = Buffer.from(blob);
  const version = buf[0];
  if (version !== ENVELOPE_V1) {
    throw new Error(`crmSecretStore: unsupported envelope version ${version}`);
  }
  const iv = buf.subarray(1, 13);
  const tag = buf.subarray(13, 29);
  const ct = buf.subarray(29);
  const decipher = createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/**
 * Encrypt the WHOLE token bundle as one envelope (00 §5.3).
 *
 * One ciphertext rather than a column per field, deliberately: the access token, the refresh token, the
 * expiry, the scopes and the instance URL are only meaningful together, and splitting them invites a partial
 * write that leaves a refresh token paired with someone else's access token. The non-secret scheduling
 * metadata the refresh worker needs (token_expires_at, scopes, external_account_id, instance_url) is
 * ALSO kept in clear columns on crm_connections — so the sweep decides refresh-vs-use without decrypting
 * anything, and the decrypt happens only in the worker that is about to call the CRM.
 */
export function encryptCrmTokenBundle(bundle: CrmTokenBundle): Uint8Array {
  return encryptCrmSecret(JSON.stringify(bundle));
}

/**
 * Decrypt a stored bundle. Throws on a tampered/unknown envelope (GCM auth) or on malformed JSON.
 *
 * Returns the parsed object WITHOUT re-validating its shape against a schema: the ciphertext is
 * authenticated, so anything that decrypts was written by us. A Zod parse here would only convert a
 * corrupt-write bug into a differently-worded throw, and the tempting `safeParse` version would hand back a
 * half-populated bundle that the caller would then send to a CRM.
 */
export function decryptCrmTokenBundle(blob: Uint8Array): CrmTokenBundle {
  return JSON.parse(decryptCrmSecret(blob)) as CrmTokenBundle;
}
