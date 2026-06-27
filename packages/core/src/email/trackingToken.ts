// trackingToken.ts — sign + verify the opaque token embedded in the open-pixel / click-redirect URL (M12 P3,
// 04, D3). The token carries the tenant/workspace/contact/enrollment the event belongs to; it is HMAC-signed
// so a recipient cannot forge or tamper a tracking hit for another tenant. Layout: base64url(json) + "." +
// hmac-sha256-hex. No SDK, no DB — pure, unit-testable. The endpoints decode it, verify the signature (fail
// closed), and idempotently record the event (a deterministic provider_event_id makes repeat opens —
// MPP/prefetch — collapse to one row, D6).
//
// SECURITY (P0, email-sec-001): the signing key is PER-TENANT, derived from the root secret via
// deriveEmailSigningKey('tracking', tenantId, root) — NOT the raw root. Use the *Scoped wrappers at the
// boundary so a token only verifies under its own tenant's key; the low-level sign/verify(payload, key) stay
// pure primitives (a caller that already holds the right key, e.g. a test).

import { createHmac, timingSafeEqual } from "node:crypto";
import { deriveEmailSigningKey } from "./signingKeys.ts";

export interface TrackingTokenPayload {
  tenantId: string;
  workspaceId: string;
  contactId: string;
  outreachLogId: string;
  messageId?: string;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function hmacHex(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/** Encode + sign a tracking token. */
export function signTrackingToken(payload: TrackingTokenPayload, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${body}.${hmacHex(body, secret)}`;
}

/** Verify + decode a tracking token. Returns null when the secret is unset, the format is bad, or the
 *  signature does not match (fail closed) — never throws. */
export function verifyTrackingToken(
  token: string | undefined | null,
  secret: string,
): TrackingTokenPayload | null {
  if (!secret || !token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmacHex(body, secret);
  const sigBuf = Buffer.from(sig, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const parsed = JSON.parse(fromB64url(body).toString("utf8")) as Partial<TrackingTokenPayload>;
    if (
      typeof parsed.tenantId !== "string" ||
      typeof parsed.workspaceId !== "string" ||
      typeof parsed.contactId !== "string" ||
      typeof parsed.outreachLogId !== "string"
    ) {
      return null;
    }
    return {
      tenantId: parsed.tenantId,
      workspaceId: parsed.workspaceId,
      contactId: parsed.contactId,
      outreachLogId: parsed.outreachLogId,
      messageId: typeof parsed.messageId === "string" ? parsed.messageId : undefined,
    };
  } catch {
    return null;
  }
}

/** Read the claimed tenantId from an UNVERIFIED token body — used only to SELECT the candidate key; the HMAC
 *  verify below then proves the token was signed with THAT tenant's key (a swapped tenant fails). */
function peekClaimedTenant(token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  try {
    const parsed = JSON.parse(fromB64url(token.slice(0, dot)).toString("utf8")) as {
      tenantId?: unknown;
    };
    return typeof parsed.tenantId === "string" ? parsed.tenantId : null;
  } catch {
    return null;
  }
}

/** Sign a tracking token with the PER-TENANT key derived from `root` (P0: no shared global secret). */
export function signTrackingTokenScoped(payload: TrackingTokenPayload, root: string): string {
  return signTrackingToken(payload, deriveEmailSigningKey("tracking", payload.tenantId, root));
}

/**
 * Verify a tracking token under the per-tenant key derived from the token's CLAIMED tenant (P0,
 * email-sec-001). A token whose tenant was tampered, or signed with a different tenant's key, fails — the
 * derived key won't match the signature. Returns null (fail closed) on any mismatch. Once it returns a
 * payload, that payload's tenant/workspace are AUTHENTIC (only a holder of this tenant's key could sign it),
 * so the caller may use them to scope the write.
 */
export function verifyTrackingTokenScoped(
  token: string | undefined | null,
  root: string,
): TrackingTokenPayload | null {
  if (!root || !token) return null;
  const claimedTenant = peekClaimedTenant(token);
  if (!claimedTenant) return null;
  return verifyTrackingToken(token, deriveEmailSigningKey("tracking", claimedTenant, root));
}
