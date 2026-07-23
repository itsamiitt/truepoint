// mfaVerify.test.ts — the email-OTP MFA factor (AUTH-025). Proves verifyMfaCode routes an "email_otp" challenge
// to the shared auth_email_tokens store keyed by the user's VERIFIED email (purpose "email_otp"), fails closed
// when there is no email or an unsupported method, and that requestEmailOtp mints a code for that address.
// userRepository + emailVerification are mocked so the test needs no DB.

import { describe, expect, it, mock } from "bun:test";

let foundUser: { id: string; email: string | null } | null = { id: "u1", email: "a@b.test" };
let verifyResult = true;
let lastVerify: { email: string; code: string; purpose?: string } | null = null;
const created: Array<{ email: string; purpose?: string }> = [];

mock.module("@leadwolf/db", () => ({
  userRepository: {
    findById: async (_id: string) => foundUser,
    listMfaMethods: async () => [],
  },
}));
mock.module("./emailVerification.ts", () => ({
  verifyEmailCode: async (input: { email: string; code: string; purpose?: string }) => {
    lastVerify = input;
    return verifyResult;
  },
  createEmailVerification: async (input: { email: string; purpose?: string }) => {
    created.push({ email: input.email, purpose: input.purpose });
    return { code: "123456" };
  },
}));

const { verifyMfaCode, requestEmailOtp } = await import("./mfaVerify.ts");

describe("verifyMfaCode — email_otp", () => {
  it("verifies the code against the user's email + purpose email_otp", async () => {
    foundUser = { id: "u1", email: "a@b.test" };
    verifyResult = true;
    expect(await verifyMfaCode({ userId: "u1", method: "email_otp", code: "123456" })).toBe(true);
    expect(lastVerify).toEqual({ email: "a@b.test", code: "123456", purpose: "email_otp" });

    verifyResult = false;
    expect(await verifyMfaCode({ userId: "u1", method: "email_otp", code: "000000" })).toBe(false);
  });

  it("fails closed when the user has no email", async () => {
    foundUser = { id: "u1", email: null };
    expect(await verifyMfaCode({ userId: "u1", method: "email_otp", code: "123456" })).toBe(false);
  });

  it("an unsupported method returns false", async () => {
    expect(await verifyMfaCode({ userId: "u1", method: "sms", code: "1" })).toBe(false);
  });
});

describe("requestEmailOtp", () => {
  it("mints a code for the user's verified email (purpose email_otp)", async () => {
    foundUser = { id: "u1", email: "a@b.test" };
    created.length = 0;
    expect(await requestEmailOtp("u1")).toEqual({ email: "a@b.test", code: "123456" });
    expect(created).toEqual([{ email: "a@b.test", purpose: "email_otp" }]);
  });

  it("returns null when the user or email is absent", async () => {
    foundUser = null;
    expect(await requestEmailOtp("u1")).toBeNull();
    foundUser = { id: "u1", email: null };
    expect(await requestEmailOtp("u1")).toBeNull();
  });
});
