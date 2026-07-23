// policyShadow.test.ts — the pure equivalence check that drives the shadow-mode match/mismatch SLI. The DB-backed
// shadowComparePolicy orchestration is covered by the effective-policy itests; here we prove the comparison
// semantics: enforcement-field equality, order-insensitive arrays, and absent-timeout equality.

import { describe, expect, it } from "bun:test";
import type { AuthPolicy } from "@leadwolf/types";
import { policiesEquivalent } from "./policyShadow.ts";

const base: AuthPolicy = {
  mfaEnforcement: "optional",
  allowedMethods: ["password", "sso"],
  disableSocial: false,
  requireSso: false,
  ipAllowlist: [],
};

describe("policiesEquivalent", () => {
  it("equal policies match", () => {
    expect(policiesEquivalent(base, { ...base })).toBe(true);
  });

  it("array fields compare order-insensitively (sets, not lists)", () => {
    expect(policiesEquivalent(base, { ...base, allowedMethods: ["sso", "password"] })).toBe(true);
    expect(
      policiesEquivalent(
        { ...base, ipAllowlist: ["10.0.0.0/8", "192.168.0.0/16"] },
        { ...base, ipAllowlist: ["192.168.0.0/16", "10.0.0.0/8"] },
      ),
    ).toBe(true);
  });

  it("a differing scalar field is a mismatch", () => {
    expect(policiesEquivalent(base, { ...base, mfaEnforcement: "required" })).toBe(false);
    expect(policiesEquivalent(base, { ...base, requireSso: true })).toBe(false);
    expect(policiesEquivalent(base, { ...base, disableSocial: true })).toBe(false);
  });

  it("a differing allowed-method SET is a mismatch", () => {
    expect(policiesEquivalent(base, { ...base, allowedMethods: ["password"] })).toBe(false);
    expect(
      policiesEquivalent(base, { ...base, allowedMethods: ["password", "sso", "passkey"] }),
    ).toBe(false);
  });

  it("absent timeout equals absent; present-vs-absent and differing values mismatch", () => {
    expect(policiesEquivalent(base, { ...base })).toBe(true); // both absent
    expect(policiesEquivalent(base, { ...base, sessionTimeoutSeconds: 3600 })).toBe(false);
    expect(
      policiesEquivalent(
        { ...base, sessionTimeoutSeconds: 3600, idleTimeoutSeconds: 900 },
        { ...base, sessionTimeoutSeconds: 3600, idleTimeoutSeconds: 900 },
      ),
    ).toBe(true);
    expect(
      policiesEquivalent(
        { ...base, idleTimeoutSeconds: 900 },
        { ...base, idleTimeoutSeconds: 1200 },
      ),
    ).toBe(false);
  });
});
