// sign.ts — the outbound-webhook signing primitives (09 §10, 26 §4). The signature scheme is the documented
// HMAC-SHA256 of `${timestamp}.${body}` against the per-subscription signing secret — the SAME math as the
// inbound Stripe verifier (billing/stripeWebhook.ts), so customers verify our payloads exactly as they would
// Stripe's. The signing secret is generated here (whsec_… prefix), stored ENCRYPTED at rest (AES-256-GCM),
// and recovered to re-sign on self-test/replay — a one-way hash could not produce a valid signature later.
// The encryption mirrors import/encryptPii.ts (iv|tag|ciphertext) but derives a webhook-specific key, so this
// module is self-contained (it does not import the private import internals).

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { env } from "@leadwolf/config";

const SECRET_PREFIX = "whsec_";
// 32 random bytes → 64 hex chars; ample entropy for an HMAC key.
const SECRET_BYTES = 32;

// Webhook-secret-at-rest key. Domain-separated from the PII key by hashing a labelled BLIND_INDEX_KEY, so a
// leak of one does not trivially decrypt the other. Production injects a dedicated KMS data key instead.
const KEY = createHash("sha256").update(`webhook-secret:${env.BLIND_INDEX_KEY}`).digest();

/** Generate a fresh plaintext signing secret (`whsec_<hex>`). Shown to the user once; never re-derivable. */
export function generateSigningSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString("hex")}`;
}

/** A non-secret display prefix for the subscriptions list, e.g. "whsec_a1b2c3…" (first 6 hex chars). */
export function secretPrefixOf(secret: string): string {
  const body = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  return `${SECRET_PREFIX}${body.slice(0, 6)}…`;
}

/** Encrypt a signing secret for at-rest storage: iv(12) | authTag(16) | ciphertext. */
export function encryptSigningSecret(plain: string): Uint8Array {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

/** Recover a signing secret from its at-rest blob (for re-signing on self-test/replay). */
export function decryptSigningSecret(blob: Uint8Array): string {
  const buf = Buffer.from(blob);
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/**
 * Build the signature header value for a payload: `t=<unix>,v1=<hmac hex>` over `${t}.${body}` — the same
 * scheme as the Stripe verifier. The receiver recomputes the HMAC with their copy of the secret and
 * constant-time-compares; an attacker who replays a captured body without the secret cannot forge `v1`.
 */
export function signWebhookPayload(
  body: string,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${v1}`;
}
