// revealCharge.test.ts — the cross-reveal-type dedup + field-aware pricing (07 §3, ADR-0013). The bug this
// guards: `email` then `full_profile` (or vice-versa) double-charging the same field. Costs are injected so
// the mapping is asserted independent of config.

import { describe, expect, test } from "bun:test";
import { revealCharge } from "./revealCharge.ts";

const costs = { email: 1, phone: 5, full: 4 };

/** The S-12 miss fields for a COMPLETE record — nothing was asked for that the contact does not carry. Spread
 *  into the full-object assertions so they stay exhaustive (toEqual still catches an unexpected extra field)
 *  without restating two constants a dozen times. Cases where a field IS absent spell them out instead. */
const NO_MISS = { missingFields: [] as string[], nothingToReveal: false };

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

// ── S-12: "already owned" vs "there is nothing here" ────────────────────────────────────────────────────────
// These were the same output until missingFields/nothingToReveal existed, which is why revealing a contact with
// no email shows the user "Already owned — no credits charged" (RevealCell.tsx, RevealDialog.tsx). Both cost
// zero, so no billing test could ever have caught it — only a test that asks WHY it cost zero.
describe("revealCharge — a missing field is not an owned field", () => {
  test("email reveal on a contact with no email reports a miss, not ownership", () => {
    const r = revealCharge({ ...base, hasEmail: false, revealType: "email" });
    expect(r.cost).toBe(0);
    expect(r.missingFields).toEqual(["email"]);
    expect(r.nothingToReveal).toBe(true);
    expect(r.newFields).toEqual([]);
  });

  test("a genuine re-reveal is owned, and misses nothing", () => {
    const r = revealCharge({ ...base, ownedEmail: true, revealType: "email" });
    expect(r.cost).toBe(0);
    expect(r.alreadyOwned).toBe(true);
    expect(r.missingFields).toEqual([]);
    expect(r.nothingToReveal).toBe(false);
  });

  test("full_profile on a contact with neither field is entirely a miss", () => {
    const r = revealCharge({
      ...base,
      hasEmail: false,
      hasPhone: false,
      revealType: "full_profile",
    });
    expect(r.missingFields.sort()).toEqual(["email", "phone"]);
    expect(r.nothingToReveal).toBe(true);
  });

  test("a partial record is NOT nothingToReveal — it exposed something", () => {
    // The distinction that makes the flag safe to branch on: one field missing and one revealed is a
    // successful reveal that happens to have a gap, not an empty record.
    const r = revealCharge({ ...base, hasPhone: false, revealType: "full_profile" });
    expect(r.newFields).toEqual(["email"]);
    expect(r.missingFields).toEqual(["phone"]);
    expect(r.nothingToReveal).toBe(false);
  });

  test("owned-plus-missing is not nothingToReveal either", () => {
    const r = revealCharge({
      ...base,
      hasPhone: false,
      ownedEmail: true,
      revealType: "full_profile",
    });
    expect(r.newFields).toEqual([]);
    expect(r.alreadyOwned).toBe(true); // nothing new exposed
    expect(r.missingFields).toEqual(["phone"]);
    expect(r.nothingToReveal).toBe(false); // but the email WAS owned, so the record is not empty
  });

  test("a phone reveal ignores a missing email — it never asked for one", () => {
    const r = revealCharge({ ...base, hasEmail: false, revealType: "phone" });
    expect(r.missingFields).toEqual([]);
    expect(r.nothingToReveal).toBe(false);
    expect(r.newFields).toEqual(["phone"]);
  });
});

describe("revealCharge — nothing owned yet", () => {
  test("email reveal charges the email price", () => {
    const r = revealCharge({ ...base, revealType: "email" });
    expect(r).toEqual({ cost: 1, alreadyOwned: false, newFields: ["email"], ...NO_MISS });
  });

  test("phone reveal charges the phone price", () => {
    const r = revealCharge({ ...base, revealType: "phone" });
    expect(r).toEqual({ cost: 5, alreadyOwned: false, newFields: ["phone"], ...NO_MISS });
  });

  test("full_profile with both fields new charges the bundle price", () => {
    const r = revealCharge({ ...base, revealType: "full_profile" });
    expect(r).toEqual({ cost: 4, alreadyOwned: false, newFields: ["email", "phone"], ...NO_MISS });
  });
});

describe("revealCharge — cross-type dedup (the fix)", () => {
  test("full_profile after email already owned charges ONLY the phone price", () => {
    const r = revealCharge({ ...base, revealType: "full_profile", ownedEmail: true });
    expect(r).toEqual({ cost: 5, alreadyOwned: false, newFields: ["phone"], ...NO_MISS });
  });

  test("full_profile after phone already owned charges ONLY the email price", () => {
    const r = revealCharge({ ...base, revealType: "full_profile", ownedPhone: true });
    expect(r).toEqual({ cost: 1, alreadyOwned: false, newFields: ["email"], ...NO_MISS });
  });

  test("full_profile after both owned is free (alreadyOwned)", () => {
    const r = revealCharge({
      ...base,
      revealType: "full_profile",
      ownedEmail: true,
      ownedPhone: true,
    });
    expect(r).toEqual({ cost: 0, alreadyOwned: true, newFields: [], ...NO_MISS });
  });

  test("email reveal when email already owned is free (alreadyOwned)", () => {
    const r = revealCharge({ ...base, revealType: "email", ownedEmail: true });
    expect(r).toEqual({ cost: 0, alreadyOwned: true, newFields: [], ...NO_MISS });
  });

  test("phone reveal when phone already owned (via a prior full_profile) is free", () => {
    const r = revealCharge({ ...base, revealType: "phone", ownedPhone: true });
    expect(r).toEqual({ cost: 0, alreadyOwned: true, newFields: [], ...NO_MISS });
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
    expect(r).toEqual({ cost: 0, alreadyOwned: false, newFields: ["email"], ...NO_MISS });
  });

  test("full_profile, email owned, new phone unusable (null status) → 0, not alreadyOwned", () => {
    const r = revealCharge({
      ...base,
      revealType: "full_profile",
      ownedEmail: true,
      phoneStatus: null,
    });
    expect(r).toEqual({ cost: 0, alreadyOwned: false, newFields: ["phone"], ...NO_MISS });
  });
});

describe("revealCharge — no ciphertext to reveal", () => {
  // These two are the ONLY cases in this file where a field is genuinely absent, so NO_MISS does not apply —
  // they are what the S-12 fields exist to describe.
  test("email reveal on a contact with no email is free, nothing new", () => {
    const r = revealCharge({ ...base, revealType: "email", hasEmail: false });
    // alreadyOwned stays TRUE here, and that is the pre-existing behaviour deliberately left untouched: the
    // S-12 change is additive, so nothing downstream shifts. missingFields/nothingToReveal are what carry the
    // truth, which is why the UI branches on them FIRST.
    expect(r).toEqual({
      cost: 0,
      alreadyOwned: true,
      newFields: [],
      missingFields: ["email"],
      nothingToReveal: true,
    });
  });

  test("full_profile on an email-only contact charges just the email", () => {
    const r = revealCharge({ ...base, revealType: "full_profile", hasPhone: false });
    expect(r).toEqual({
      cost: 1,
      alreadyOwned: false,
      newFields: ["email"],
      missingFields: ["phone"],
      // A gap is not an empty record — the email WAS revealed.
      nothingToReveal: false,
    });
  });
});
