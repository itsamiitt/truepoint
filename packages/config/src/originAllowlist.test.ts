// originAllowlist.test.ts — proves isAllowedOrigin is an EXACT allow-list check. It is the guard the
// magic-link, password-reset and password flows rely on to refuse an attacker-supplied return origin
// (open-redirect + cross-domain code leak). APP_ORIGINS is seeded to "https://app.test" by test/setup.ts.
import { describe, expect, it } from "bun:test";
import { isAllowedOrigin } from "./env.ts";

describe("isAllowedOrigin", () => {
  it("accepts an exact allow-listed origin", () => {
    expect(isAllowedOrigin("https://app.test")).toBe(true);
  });

  it("rejects an unknown origin (the open-redirect guard)", () => {
    expect(isAllowedOrigin("https://evil.example")).toBe(false);
  });

  it("rejects null, undefined, and empty", () => {
    expect(isAllowedOrigin(null)).toBe(false);
    expect(isAllowedOrigin(undefined)).toBe(false);
    expect(isAllowedOrigin("")).toBe(false);
  });

  it("rejects non-exact / substring near-matches", () => {
    expect(isAllowedOrigin("https://app.test.evil.example")).toBe(false);
    expect(isAllowedOrigin("https://app.test/")).toBe(false);
  });
});
