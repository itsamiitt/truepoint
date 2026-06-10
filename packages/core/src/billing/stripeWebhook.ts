// stripeWebhook.ts — verify a Stripe webhook signature (the documented HMAC-SHA256 scheme: signed payload
// `${t}.${body}` against the endpoint secret) and extract the credit grant from a payment_intent.succeeded
// event. No Stripe SDK: the signature math is small, stable, and unit-testable (07 §4). The webhook is the
// ONLY place credits are granted — never client-side.

import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TOLERANCE_SECONDS = 300;

/** Parse `Stripe-Signature: t=...,v1=...[,v1=...]` into its parts. Returns null when malformed. */
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

/** True when the payload was signed with `secret` and the timestamp is within tolerance. */
export function verifyStripeSignature(
  payload: string,
  header: string | null | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): boolean {
  if (!header) return false;
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

/** Build a valid `Stripe-Signature` header for tests / fixtures (same math the verifier checks). */
export function signStripePayload(
  payload: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

export interface CreditGrantEvent {
  stripeEventId: string;
  stripePaymentIntentId: string | null;
  tenantId: string;
  credits: number;
  amountCents: number | null;
}

/**
 * Extract the grant from a verified event. Returns null for event types we ignore (the route still 200s —
 * Stripe retries on non-2xx). The checkout flow stamps `metadata.tenant_id` + `metadata.credits` on the
 * PaymentIntent; a succeeded intent without them is logged-and-ignored rather than mis-granted.
 */
export function parseCreditGrantEvent(rawEvent: unknown): CreditGrantEvent | null {
  if (typeof rawEvent !== "object" || rawEvent === null) return null;
  const event = rawEvent as {
    id?: unknown;
    type?: unknown;
    data?: { object?: { id?: unknown; amount?: unknown; metadata?: Record<string, unknown> } };
  };
  if (event.type !== "payment_intent.succeeded" || typeof event.id !== "string") return null;
  const intent = event.data?.object;
  const metadata = intent?.metadata ?? {};
  const tenantId = typeof metadata.tenant_id === "string" ? metadata.tenant_id : null;
  const credits = Number(metadata.credits);
  if (!tenantId || !Number.isInteger(credits) || credits <= 0) return null;
  return {
    stripeEventId: event.id,
    stripePaymentIntentId: typeof intent?.id === "string" ? intent.id : null,
    tenantId,
    credits,
    amountCents: typeof intent?.amount === "number" ? intent.amount : null,
  };
}
