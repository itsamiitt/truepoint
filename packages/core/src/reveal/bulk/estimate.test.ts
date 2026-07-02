// estimate.test.ts — the worst-case bulk-reveal estimate (billable = has an un-owned field for the type).

import { describe, expect, test } from "bun:test";
import { projectRevealEstimate } from "./estimate.ts";

const c = (hasEmail: boolean, hasPhone: boolean, ownedEmail: boolean, ownedPhone: boolean) => ({
  hasEmail,
  hasPhone,
  ownedEmail,
  ownedPhone,
});

describe("projectRevealEstimate", () => {
  test("email: only contacts with an un-owned email are billable", () => {
    const set = [
      c(true, false, false, false), // billable
      c(true, false, true, false), // already owned → free
      c(false, false, false, false), // no email → neither billable nor owned
      c(true, true, false, false), // billable (email un-owned)
    ];
    expect(projectRevealEstimate("email", set, 1)).toEqual({
      totalContacts: 4,
      billableContacts: 2,
      alreadyOwnedContacts: 1,
      projectedMaxCredits: 2,
    });
  });

  test("phone: phone cost applied, phone ownership respected", () => {
    const set = [
      c(true, true, false, false), // billable (phone)
      c(true, true, false, true), // phone owned → free
      c(true, false, false, false), // no phone → neither
    ];
    expect(projectRevealEstimate("phone", set, 5)).toEqual({
      totalContacts: 3,
      billableContacts: 1,
      alreadyOwnedContacts: 1,
      projectedMaxCredits: 5,
    });
  });

  test("full_profile: billable when ANY field is un-owned; owned = has a field but fully owned", () => {
    const set = [
      c(true, true, false, false), // billable (both new)
      c(true, true, true, false), // billable (phone still new)
      c(true, true, true, true), // fully owned → free
      c(false, false, false, false), // nothing
    ];
    expect(projectRevealEstimate("full_profile", set, 4)).toEqual({
      totalContacts: 4,
      billableContacts: 2,
      alreadyOwnedContacts: 1,
      projectedMaxCredits: 8,
    });
  });

  test("empty selection → all zeros", () => {
    expect(projectRevealEstimate("email", [], 1)).toEqual({
      totalContacts: 0,
      billableContacts: 0,
      alreadyOwnedContacts: 0,
      projectedMaxCredits: 0,
    });
  });
});
