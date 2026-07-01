// stripeWebhook.test.ts — unit tests for the webhook signature scheme + grant-event extraction (07 §4).

import { describe, expect, test } from "bun:test";
import {
  parseCreditGrantEvent,
  parseSubscriptionEvent,
  signStripePayload,
  verifyStripeSignature,
} from "./stripeWebhook.ts";

const TENANT = "11111111-1111-1111-1111-111111111111";
const subEvent = (type: string, obj: Record<string, unknown>) => ({
  id: "evt_s",
  type,
  data: { object: obj },
});
const subObject = (over: Record<string, unknown> = {}) => ({
  id: "sub_1",
  status: "active",
  current_period_start: 1_700_000_000,
  current_period_end: 1_702_592_000,
  cancel_at_period_end: false,
  metadata: { tenant_id: TENANT, plan_template_key: "pro" },
  ...over,
});

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

describe("parseSubscriptionEvent", () => {
  test("created/updated → an upsert event with tenant, plan, status + periods", () => {
    expect(parseSubscriptionEvent(subEvent("customer.subscription.created", subObject()))).toEqual({
      stripeEventId: "evt_s",
      kind: "upsert",
      stripeSubscriptionId: "sub_1",
      tenantId: TENANT,
      planTemplateKey: "pro",
      status: "active",
      currentPeriodStart: 1_700_000_000,
      currentPeriodEnd: 1_702_592_000,
      cancelAtPeriodEnd: false,
    });
    const updated = parseSubscriptionEvent(
      subEvent("customer.subscription.updated", subObject({ status: "past_due" })),
    );
    expect(updated?.kind).toBe("upsert");
    expect(updated?.status).toBe("past_due");
  });

  test("deleted → a deleted event forced to canceled", () => {
    const ev = parseSubscriptionEvent(
      subEvent("customer.subscription.deleted", subObject({ status: "active" })),
    );
    expect(ev?.kind).toBe("deleted");
    expect(ev?.status).toBe("canceled");
  });

  test("invoice.payment_failed → a past_due event keyed by the subscription id (no tenant needed)", () => {
    expect(
      parseSubscriptionEvent(subEvent("invoice.payment_failed", { subscription: "sub_1" })),
    ).toMatchObject({ kind: "past_due", stripeSubscriptionId: "sub_1", tenantId: "" });
  });

  test("ignores a subscription with no tenant metadata, unrelated types, and null", () => {
    expect(
      parseSubscriptionEvent(
        subEvent("customer.subscription.created", subObject({ metadata: {} })),
      ),
    ).toBeNull();
    expect(parseSubscriptionEvent(subEvent("charge.succeeded", { id: "ch_1" }))).toBeNull();
    expect(parseSubscriptionEvent(subEvent("invoice.payment_failed", {}))).toBeNull();
    expect(parseSubscriptionEvent(null)).toBeNull();
  });
});
