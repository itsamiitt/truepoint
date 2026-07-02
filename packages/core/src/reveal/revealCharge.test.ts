// revealCharge.test.ts — the cross-reveal-type dedup + field-aware pricing (07 §3, ADR-0013). The bug this
// guards: `email` then `full_profile` (or vice-versa) double-charging the same field. Costs are injected so
// the mapping is asserted independent of config.

import { describe, expect, test } from "bun:test";
import { revealCharge } from "./revealCharge.ts";

const costs = { email: 1, phone: 5, full: 4 };
const base = {
  hasEmail: true,
  hasPhone: true,
  ownedEmail: false,
  ownedPhone: false,
  emailStatus: "valid" as const,
  phoneStatus: "valid" as const,
  costs,
  chargeRisky: true,
};

describe("revealCharge — nothing owned yet", () => {
  test("email reveal charges the email price", () => {
    const r = revealCharge({ ...base, revealType: "email" });
    expect(r).toEqual({ cost: 1, alreadyOwned: false, newFields: ["email"] });
  });

  test("phone reveal charges the phone price", () => {
    const r = revealCharge({ ...base, revealType: "phone" });
    expect(r).toEqual({ cost: 5, alreadyOwned: false, newFields: ["phone"] });
  });

  test("full_profile with both fields new charges the bundle price", () => {
    const r = revealCharge({ ...base, revealType: "full_profile" });
    expect(r).toEqual({ cost: 4, alreadyOwned: false, newFields: ["email", "phone"] });
  });
});

describe("revealCharge — cross-type dedup (the fix)", () => {
  test("full_profile after email already owned charges ONLY the phone price", () => {
    const r = revealCharge({ ...base, revealType: "full_profile", ownedEmail: true });
    expect(r).toEqual({ cost: 5, alreadyOwned: false, newFields: ["phone"] });
  });

  test("full_profile after phone already owned charges ONLY the email price", () => {
    const r = revealCharge({ ...base, revealType: "full_profile", ownedPhone: true });
    expect(r).toEqual({ cost: 1, alreadyOwned: false, newFields: ["email"] });
  });

  test("full_profile after both owned is free (alreadyOwned)", () => {
    const r = revealCharge({
      ...base,
      revealType: "full_profile",
      ownedEmail: true,
      ownedPhone: true,
    });
    expect(r).toEqual({ cost: 0, alreadyOwned: true, newFields: [] });
  });

  test("email reveal when email already owned is free (alreadyOwned)", () => {
    const r = revealCharge({ ...base, revealType: "email", ownedEmail: true });
    expect(r).toEqual({ cost: 0, alreadyOwned: true, newFields: [] });
  });

  test("phone reveal when phone already owned (via a prior full_profile) is free", () => {
    const r = revealCharge({ ...base, revealType: "phone", ownedPhone: true });
    expect(r).toEqual({ cost: 0, alreadyOwned: true, newFields: [] });
  });
});

describe("revealCharge — verified-result grading still applies to the new field", () => {
  test("full_profile, phone owned, new email invalid → 0 (but not alreadyOwned)", () => {
    const r = revealCharge({
      ...base,
      revealType: "full_profile",
      ownedPhone: true,
      emailStatus: "invalid",
    });
    expect(r).toEqual({ cost: 0, alreadyOwned: false, newFields: ["email"] });
  });

  test("full_profile, email owned, new phone unusable (null status) → 0, not alreadyOwned", () => {
    const r = revealCharge({
      ...base,
      revealType: "full_profile",
      ownedEmail: true,
      phoneStatus: null,
    });
    expect(r).toEqual({ cost: 0, alreadyOwned: false, newFields: ["phone"] });
  });
});

describe("revealCharge — no ciphertext to reveal", () => {
  test("email reveal on a contact with no email is free, nothing new", () => {
    const r = revealCharge({ ...base, revealType: "email", hasEmail: false });
    expect(r).toEqual({ cost: 0, alreadyOwned: true, newFields: [] });
  });

  test("full_profile on an email-only contact charges just the email", () => {
    const r = revealCharge({ ...base, revealType: "full_profile", hasPhone: false });
    expect(r).toEqual({ cost: 1, alreadyOwned: false, newFields: ["email"] });
  });
});
