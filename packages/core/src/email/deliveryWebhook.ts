// deliveryWebhook.ts — verify a signed delivery/bounce/complaint webhook from the ESP and extract the event
// (email-planning/13 P1, 04 §6, 08 §6). Mirrors core/billing/stripeWebhook.ts exactly: HMAC-SHA256 over
// `${timestamp}.${payload}` against the configured secret, constant-time compare, timestamp tolerance — no
// SDK, small + stable + unit-testable. The ingest is the ONLY path a bounce feeds suppression + credit-back
// (via the unchanged M9 handleBounce); a forged/unsigned/replayed payload is rejected. The signed event
// carries the tenant/workspace/log it refers to; RLS still scopes handleBounce to that workspace.

import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TOLERANCE_SECONDS = 300;

/** Parse `X-TP-Email-Signature: t=...,v1=...` into its parts. Returns null when malformed. */
function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } | null {
  const parts = header.split(",").map((p) => p.trim());
  let timestamp = Number.NaN;
  const signatures: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 1) return null;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "t") timestamp = Number(value);
    if (key === "v1") signatures.push(value);
  }
  if (!Number.isFinite(timestamp) || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/** True when `payload` was signed with `secret` and the timestamp is within tolerance. */
export function verifyEmailWebhookSignature(
  payload: string,
  header: string | null | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): boolean {
  if (!secret || !header) return false;
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) return false;

  const expected = createHmac("sha256", secret)
    .update(`${parsed.timestamp}.${payload}`, "utf8")
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  return parsed.signatures.some((sig) => {
    const sigBuf = Buffer.from(sig, "utf8");
    return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
  });
}

/** Build a valid signature header for tests / fixtures (same math the verifier checks). */
export function signEmailWebhookPayload(
  payload: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

export type DeliveryEventType = "delivery" | "bounce" | "complaint";

export interface DeliveryEvent {
  /** The provider's event id — the ingestion-idempotency key (email_event.provider_event_id, 15 §A.2). */
  providerEventId: string;
  type: DeliveryEventType;
  tenantId: string;
  workspaceId: string;
  /** The enrollment this event refers to — drives handleBounce for bounce/complaint (08 §6). */
  outreachLogId: string | null;
  messageId: string | null;
}

/**
 * Extract a typed event from a VERIFIED payload. Returns null for shapes we ignore (the route still 200s so
 * the ESP does not retry a benign event forever). The fields below are the contract the P1b adapters emit;
 * a payload missing the required ids is ignored rather than mis-applied.
 */
export function parseDeliveryEvent(rawEvent: unknown): DeliveryEvent | null {
  if (typeof rawEvent !== "object" || rawEvent === null) return null;
  const e = rawEvent as Record<string, unknown>;
  const type = e.type;
  if (type !== "delivery" && type !== "bounce" && type !== "complaint") return null;
  if (
    typeof e.providerEventId !== "string" ||
    typeof e.tenantId !== "string" ||
    typeof e.workspaceId !== "string"
  ) {
    return null;
  }
  return {
    providerEventId: e.providerEventId,
    type,
    tenantId: e.tenantId,
    workspaceId: e.workspaceId,
    outreachLogId: typeof e.outreachLogId === "string" ? e.outreachLogId : null,
    messageId: typeof e.messageId === "string" ? e.messageId : null,
  };
}
