// magicCarry.test.ts — proves the magic-link carry parser is tamper-safe. The cookie value is the only
// place untrusted input reaches completeMagic, so decode MUST return null (never throw) for forged/garbage
// input, and a legitimate value must round-trip exactly. (Security review F-series.)
import { describe, expect, it } from "bun:test";
import { type MagicCarry, decodeMagicCarry, encodeMagicCarry } from "./magicCarry.ts";

describe("magicCarry", () => {
  const carry: MagicCarry = {
    appOrigin: "https://app.test",
    codeChallenge: "abc123",
    state: "xyz",
  };

  it("round-trips a valid carry", () => {
    expect(decodeMagicCarry(encodeMagicCarry(carry))).toEqual(carry);
  });

  it("returns null for undefined / empty input", () => {
    expect(decodeMagicCarry(undefined)).toBeNull();
    expect(decodeMagicCarry("")).toBeNull();
  });

  it("returns null for garbage / non-JSON input without throwing", () => {
    expect(decodeMagicCarry("not-base64-$$$")).toBeNull();
    expect(decodeMagicCarry(Buffer.from("not json", "utf8").toString("base64url"))).toBeNull();
  });

  it("coerces missing fields to empty strings (never undefined)", () => {
    const partial = Buffer.from(JSON.stringify({ appOrigin: "https://app.test" }), "utf8").toString(
      "base64url",
    );
    expect(decodeMagicCarry(partial)).toEqual({
      appOrigin: "https://app.test",
      codeChallenge: "",
      state: "",
    });
  });
});
