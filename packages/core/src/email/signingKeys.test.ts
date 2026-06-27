// signingKeys.test.ts — the P0 (email-sec-001) crypto property: signing keys are PER-TENANT, derived from the
// root. Pure, no infra. Proves different tenants get independent keys (so a holder of one tenant's key cannot
// produce another tenant's), purposes are domain-separated, and an unset root/tenant fails closed.

import { describe, expect, test } from "bun:test";
import { deriveEmailSigningKey } from "./signingKeys.ts";

const ROOT = "root_secret_for_test_0123456789";
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

describe("deriveEmailSigningKey", () => {
  test("is deterministic for the same (purpose, tenant, root)", () => {
    expect(deriveEmailSigningKey("webhook", A, ROOT)).toBe(
      deriveEmailSigningKey("webhook", A, ROOT),
    );
  });

  test("different tenants get different keys (the P0 isolation property)", () => {
    expect(deriveEmailSigningKey("webhook", A, ROOT)).not.toBe(
      deriveEmailSigningKey("webhook", B, ROOT),
    );
  });

  test("webhook and tracking keys for the same tenant are domain-separated", () => {
    expect(deriveEmailSigningKey("webhook", A, ROOT)).not.toBe(
      deriveEmailSigningKey("tracking", A, ROOT),
    );
  });

  test("a different root yields a different key", () => {
    expect(deriveEmailSigningKey("webhook", A, ROOT)).not.toBe(
      deriveEmailSigningKey("webhook", A, "a_different_root_0000"),
    );
  });

  test("fails closed: an unset root or tenant → empty key", () => {
    expect(deriveEmailSigningKey("webhook", A, "")).toBe("");
    expect(deriveEmailSigningKey("webhook", A, undefined)).toBe("");
    expect(deriveEmailSigningKey("webhook", A, null)).toBe("");
    expect(deriveEmailSigningKey("webhook", "", ROOT)).toBe("");
  });
});
