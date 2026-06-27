// signingKeys.ts — per-tenant derivation of the email signing keys (P0 hotfix for email-sec-001: the global
// EMAIL_WEBHOOK_SECRET let a holder of the one secret forge a SIGNED webhook / tracking hit naming ANY
// tenant, and the route trusted the tenant/workspace FROM the signed payload to set the RLS GUCs — a
// cross-tenant write). The fix: the env secret is a ROOT, never a direct key. Each (purpose, tenant) gets an
// INDEPENDENT key = HMAC-SHA256(root, `${purpose}:v1:${tenantId}`). HMAC is a one-way PRF, so possessing one
// tenant's derived key never reveals the root or any OTHER tenant's key — so a forged payload for tenant B
// only verifies under tenant B's key, which an attacker holding tenant A's key cannot produce. `purpose`
// domain-separates the ESP-webhook key from the open/click tracking key for the same tenant. Returns "" when
// the root (or tenant) is unset so every downstream verify FAILS CLOSED (the same posture as a missing
// secret). The root is server-only — never logged, never sent to a client.

import { createHmac } from "node:crypto";

export type EmailSigningPurpose = "webhook" | "tracking";

/**
 * Derive the per-tenant signing key for an email purpose from the root secret. Deterministic, pure. Fails
 * closed (returns "") when the root or tenantId is empty, so a caller passing the key to a verifier rejects
 * everything rather than accepting an unkeyed signature.
 */
export function deriveEmailSigningKey(
  purpose: EmailSigningPurpose,
  tenantId: string,
  root: string | undefined | null,
): string {
  if (!root || !tenantId) return "";
  return createHmac("sha256", root).update(`${purpose}:v1:${tenantId}`, "utf8").digest("hex");
}
