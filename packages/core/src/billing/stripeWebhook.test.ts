// stripeWebhook.test.ts — unit tests for the webhook signature scheme + grant-event extraction (07 §4).

import { describe, expect, test } from "bun:test";
import {
  parseCreditGrantEvent,
  signStripePayload,
  verifyStripeSignature,
} from "./stripeWebhook.ts";

const SECRET = "whsec_test_secret";
const NOW = 1_700_000_000;

const event = (over: Record<string, unknown> = {}) => ({
  id: "evt_1",
  type: "payment_intent.succeeded",
  data: {
    object: {
      id: "pi_1",
      amount: 4900,
      metadata: { tenant_id: "11111111-1111-1111-1111-111111111111", credits: "500" },
    },
  },
  ...over,
});

describe("verifyStripeSignature", () => {
  test("accepts a payload signed with the secret", () => {
    const payload = JSON.stringify(event());
    const header = signStripePayload(payload, SECRET, NOW);
    expect(verifyStripeSignature(payload, header, SECRET, NOW)).toBe(true);
  });

  test("rejects a tampered payload", () => {
    const payload = JSON.stringify(event());
    const header = signStripePayload(payload, SECRET, NOW);
    expect(verifyStripeSignature(`${payload} `, header, SECRET, NOW)).toBe(false);
  });

  test("rejects the wrong secret, a stale timestamp, and malformed headers", () => {
    const payload = JSON.stringify(event());
    const header = signStripePayload(payload, SECRET, NOW);
    expect(verifyStripeSignature(payload, header, "whsec_other", NOW)).toBe(false);
    expect(verifyStripeSignature(payload, header, SECRET, NOW + 3600)).toBe(false);
    expect(verifyStripeSignature(payload, "v1=zzz", SECRET, NOW)).toBe(false);
    expect(verifyStripeSignature(payload, null, SECRET, NOW)).toBe(false);
  });
});

describe("parseCreditGrantEvent", () => {
  test("extracts tenant + credits from payment_intent.succeeded", () => {
    expect(parseCreditGrantEvent(event())).toEqual({
      stripeEventId: "evt_1",
      stripePaymentIntentId: "pi_1",
      tenantId: "11111111-1111-1111-1111-111111111111",
      credits: 500,
      amountCents: 4900,
    });
  });

  test("ignores other event types and missing/invalid metadata", () => {
    expect(parseCreditGrantEvent(event({ type: "charge.refunded" }))).toBeNull();
    expect(
      parseCreditGrantEvent(
        event({ data: { object: { id: "pi_1", metadata: { credits: "500" } } } }),
      ),
    ).toBeNull();
    expect(
      parseCreditGrantEvent(
        event({ data: { object: { id: "pi_1", metadata: { tenant_id: "t", credits: "-5" } } } }),
      ),
    ).toBeNull();
    expect(parseCreditGrantEvent(null)).toBeNull();
  });
});
