// trackingToken.test.ts — the open-pixel/click tracking token (M12 P3). Pure, runs without infra. Proves a
// signed token round-trips, and a tampered body / wrong secret / missing secret / garbage is rejected
// (fail closed) — the forgery boundary for tracking hits.

import { describe, expect, test } from "bun:test";
import { signTrackingToken, verifyTrackingToken } from "./trackingToken.ts";

const SECRET = "whsec_email_test_0123456789";
const payload = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  workspaceId: "22222222-2222-2222-2222-222222222222",
  contactId: "33333333-3333-3333-3333-333333333333",
  outreachLogId: "44444444-4444-4444-4444-444444444444",
};

describe("tracking token", () => {
  test("round-trips a signed token", () => {
    const decoded = verifyTrackingToken(signTrackingToken(payload, SECRET), SECRET);
    expect(decoded).toEqual({ ...payload, messageId: undefined });
  });

  test("a tampered body is rejected", () => {
    const token = signTrackingToken(payload, SECRET);
    const [body, sig] = token.split(".");
    const forged = `${body}x.${sig}`;
    expect(verifyTrackingToken(forged, SECRET)).toBeNull();
  });

  test("the wrong secret is rejected", () => {
    expect(verifyTrackingToken(signTrackingToken(payload, SECRET), "other_secret_000")).toBeNull();
  });

  test("a missing secret or garbage token fails closed", () => {
    expect(verifyTrackingToken(signTrackingToken(payload, SECRET), "")).toBeNull();
    expect(verifyTrackingToken(null, SECRET)).toBeNull();
    expect(verifyTrackingToken("garbage", SECRET)).toBeNull();
    expect(verifyTrackingToken("a.b.c", SECRET)).toBeNull();
  });

  test("carries an optional messageId", () => {
    const decoded = verifyTrackingToken(
      signTrackingToken({ ...payload, messageId: "msg_9" }, SECRET),
      SECRET,
    );
    expect(decoded?.messageId).toBe("msg_9");
  });
});
