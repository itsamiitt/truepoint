// code.test.ts — proves exchangeCode's validation now reports WHICH check failed (the diagnostic that made
// the production "Sign-in could not be completed" opaque). validateBinding is pure (no Redis), so we test it
// directly. AUTH_BIND_IP defaults to "prefix" and APP_ORIGINS is seeded to "https://app.test" (test/setup.ts).
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { type CodeBinding, validateBinding } from "./code.ts";

const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");
const VERIFIER = "pkce-verifier-abcdefghijklmnopqrstuvwxyz0123456789";

const binding = (over: Partial<CodeBinding> = {}): CodeBinding => ({
  userId: "u1",
  tenantId: "t1",
  sessionId: "s1",
  appOrigin: "https://app.test", // the seeded APP_ORIGINS entry
  clientIp: "203.0.113.10",
  codeChallenge: s256(VERIFIER),
  ...over,
});

// IP .200 shares the /24 with the bound .10 → passes under the default "prefix" mode.
const goodArgs = { codeVerifier: VERIFIER, clientIp: "203.0.113.200", origin: "https://app.test" };

describe("validateBinding", () => {
  it("returns null when IP (same /24), origin, and PKCE all match", () => {
    expect(validateBinding(binding(), goodArgs)).toBeNull();
  });

  it("flags ip_mismatch when the exchange IP is on a different network", () => {
    expect(validateBinding(binding(), { ...goodArgs, clientIp: "198.51.100.7" })).toBe(
      "ip_mismatch",
    );
  });

  it("flags origin_mismatch when the request origin isn't allow-listed", () => {
    expect(validateBinding(binding(), { ...goodArgs, origin: "https://evil.test" })).toBe(
      "origin_mismatch",
    );
  });

  it("flags origin_mismatch when the bound appOrigin differs from the request origin", () => {
    expect(validateBinding(binding({ appOrigin: "https://other.test" }), goodArgs)).toBe(
      "origin_mismatch",
    );
  });

  it("flags pkce_mismatch when the verifier doesn't match the bound challenge", () => {
    expect(validateBinding(binding(), { ...goodArgs, codeVerifier: "the-wrong-verifier" })).toBe(
      "pkce_mismatch",
    );
  });

  it("checks IP before origin before PKCE (priority order)", () => {
    const r = validateBinding(binding({ appOrigin: "https://other.test" }), {
      codeVerifier: "wrong",
      clientIp: "198.51.100.7",
      origin: "https://evil.test",
    });
    expect(r).toBe("ip_mismatch");
  });
});
