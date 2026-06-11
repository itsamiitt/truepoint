// chargeFor.test.ts — the ADR-0013 charge-by-verified-result mapping, exhaustively (07 §3).

import { describe, expect, test } from "bun:test";
import { chargeFor } from "./chargeFor.ts";
import { validatePhone } from "./validatePhone.ts";

const base = { revealType: "email" as const, baseCost: 2, chargeRisky: true };

describe("chargeFor (ADR-0013)", () => {
  test("valid charges full cost; verifier-determined unusable results charge 0", () => {
    expect(chargeFor({ ...base, emailStatus: "valid" })).toBe(2);
    expect(chargeFor({ ...base, emailStatus: "invalid" })).toBe(0);
    expect(chargeFor({ ...base, emailStatus: "catch_all" })).toBe(0);
    expect(chargeFor({ ...base, emailStatus: "unknown" })).toBe(0);
  });

  test("risky is charged-but-flagged by default and configurable to 0", () => {
    expect(chargeFor({ ...base, emailStatus: "risky" })).toBe(2);
    expect(chargeFor({ ...base, emailStatus: "risky", chargeRisky: false })).toBe(0);
  });

  test("unverified (no verifier ran) keeps the pre-verifier full charge", () => {
    expect(chargeFor({ ...base, emailStatus: "unverified" })).toBe(2);
  });

  test("phone reveals charge only when a chargeable line status resolves", () => {
    expect(
      chargeFor({
        revealType: "phone",
        baseCost: 3,
        chargeRisky: true,
        emailStatus: "unverified",
        phoneStatus: "valid",
      }),
    ).toBe(3);
    expect(
      chargeFor({
        revealType: "phone",
        baseCost: 3,
        chargeRisky: true,
        emailStatus: "valid",
        phoneStatus: "invalid",
      }),
    ).toBe(0);
    expect(
      chargeFor({
        revealType: "phone",
        baseCost: 3,
        chargeRisky: true,
        emailStatus: "valid",
        phoneStatus: null,
      }),
    ).toBe(0);
  });
});

describe("validatePhone", () => {
  test("E.164-shaped numbers are valid; junk is invalid", () => {
    expect(validatePhone("+14155552671")).toBe("valid");
    expect(validatePhone("+44 20 7946 0958")).toBe("valid");
    expect(validatePhone("not-a-number")).toBe("invalid");
    expect(validatePhone("0123")).toBe("invalid");
  });
});
