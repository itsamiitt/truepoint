// deliveryWebhook.test.ts — the signed ESP delivery/bounce webhook verify + parse (M12, email-planning/13 P1,
// 04 §6). Pure (no @leadwolf/config / DB import), runs without a network. Proves: a correctly-signed payload
// verifies; a tampered body / wrong secret / stale timestamp / missing secret is rejected (fail closed); the
// event parser returns the typed event for known types and null for benign/unknown shapes.

import { describe, expect, test } from "bun:test";
import {
  parseDeliveryEvent,
  signEmailWebhookPayload,
  verifyEmailWebhookSignature,
} from "./deliveryWebhook.ts";
import { deriveEmailSigningKey } from "./signingKeys.ts";

const SECRET = "whsec_email_test_0123456789";
const NOW = 1_700_000_000;

describe("verifyEmailWebhookSignature", () => {
  test("a correctly-signed payload verifies", () => {
    const payload = '{"type":"bounce","providerEventId":"e1"}';
    const header = signEmailWebhookPayload(payload, SECRET, NOW);
    expect(verifyEmailWebhookSignature(payload, header, SECRET, NOW)).toBe(true);
  });

  test("a tampered body is rejected", () => {
    const header = signEmailWebhookPayload('{"type":"bounce"}', SECRET, NOW);
    expect(verifyEmailWebhookSignature('{"type":"delivery"}', header, SECRET, NOW)).toBe(false);
  });

  test("the wrong secret is rejected", () => {
    const payload = '{"type":"bounce"}';
    const header = signEmailWebhookPayload(payload, SECRET, NOW);
    expect(verifyEmailWebhookSignature(payload, header, "whsec_wrong_key_000000", NOW)).toBe(false);
  });

  test("a stale timestamp (replay) is rejected", () => {
    const payload = '{"type":"bounce"}';
    const header = signEmailWebhookPayload(payload, SECRET, NOW - 10_000);
    expect(verifyEmailWebhookSignature(payload, header, SECRET, NOW)).toBe(false);
  });

  test("a missing secret or header fails closed", () => {
    const payload = '{"type":"bounce"}';
    const header = signEmailWebhookPayload(payload, SECRET, NOW);
    expect(verifyEmailWebhookSignature(payload, header, "", NOW)).toBe(false);
    expect(verifyEmailWebhookSignature(payload, null, SECRET, NOW)).toBe(false);
    expect(verifyEmailWebhookSignature(payload, "garbage", SECRET, NOW)).toBe(false);
  });
});

describe("parseDeliveryEvent", () => {
  test("a well-formed bounce parses to the typed event", () => {
    const event = parseDeliveryEvent({
      type: "bounce",
      providerEventId: "evt_123",
      tenantId: "11111111-1111-1111-1111-111111111111",
      workspaceId: "22222222-2222-2222-2222-222222222222",
      outreachLogId: "33333333-3333-3333-3333-333333333333",
      messageId: "msg_9",
    });
    expect(event).not.toBeNull();
    expect(event?.type).toBe("bounce");
    expect(event?.providerEventId).toBe("evt_123");
    expect(event?.outreachLogId).toBe("33333333-3333-3333-3333-333333333333");
  });

  test("an unknown type → null (ignored, route still 200s)", () => {
    expect(
      parseDeliveryEvent({
        type: "spam_report",
        providerEventId: "x",
        tenantId: "a",
        workspaceId: "b",
      }),
    ).toBeNull();
  });

  test("a payload missing the required ids → null", () => {
    expect(parseDeliveryEvent({ type: "bounce", providerEventId: "x" })).toBeNull();
    expect(parseDeliveryEvent(null)).toBeNull();
    expect(parseDeliveryEvent("not-an-object")).toBeNull();
  });

  test("optional ids default to null", () => {
    const event = parseDeliveryEvent({
      type: "delivery",
      providerEventId: "evt_d",
      tenantId: "t",
      workspaceId: "w",
    });
    expect(event?.outreachLogId).toBeNull();
    expect(event?.messageId).toBeNull();
  });
});

describe("per-tenant webhook key (P0 email-sec-001)", () => {
  const ROOT = "root_secret_webhook_0000";
  const A = "11111111-1111-1111-1111-111111111111";
  const B = "22222222-2222-2222-2222-222222222222";

  test("a payload signed with tenant A's key fails verification under tenant B's key", () => {
    const payload = `{"type":"bounce","providerEventId":"e1","tenantId":"${A}"}`;
    const header = signEmailWebhookPayload(payload, deriveEmailSigningKey("webhook", A, ROOT), NOW);
    // The route derives the key from the CLAIMED tenant: an attacker claiming B but holding only A's key fails.
    expect(
      verifyEmailWebhookSignature(payload, header, deriveEmailSigningKey("webhook", B, ROOT), NOW),
    ).toBe(false);
    // The legitimate path — verified under tenant A's own key — passes.
    expect(
      verifyEmailWebhookSignature(payload, header, deriveEmailSigningKey("webhook", A, ROOT), NOW),
    ).toBe(true);
  });
});
