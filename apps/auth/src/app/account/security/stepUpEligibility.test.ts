// stepUpEligibility.test.ts — guards AUTH-069. The predicate must mirror verifyStepUp's contract exactly:
// step-up is satisfiable iff the user has a password OR a verified TOTP factor. The passwordless-and-factorless
// case (false) is the bootstrap trap the MFA UI must handle by offering "set a password" instead of an unusable
// enroll form.
import { describe, expect, it } from "bun:test";
import { canStepUp } from "./stepUpEligibility.ts";

describe("canStepUp", () => {
  it("is true when the user has a password", () => {
    expect(canStepUp({ hasPassword: true, hasVerifiedTotp: false })).toBe(true);
    expect(canStepUp({ hasPassword: true, hasVerifiedTotp: true })).toBe(true);
  });

  it("is true for a passwordless user who already has a verified TOTP factor", () => {
    expect(canStepUp({ hasPassword: false, hasVerifiedTotp: true })).toBe(true);
  });

  it("is FALSE for a passwordless user with no verified factor (the AUTH-069 bootstrap trap)", () => {
    expect(canStepUp({ hasPassword: false, hasVerifiedTotp: false })).toBe(false);
  });
});
