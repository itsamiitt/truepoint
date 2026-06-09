// normalize.test.ts — the pre-hash normalizers must be stable + predictable; dedup correctness depends on it.
import { describe, expect, test } from "bun:test";
import {
  emailDomainOf,
  linkedinPublicIdOf,
  normalizeDomain,
  normalizeEmailForIndex,
  normalizeEmailForStorage,
  normalizeText,
} from "./normalize.ts";

describe("normalizeText", () => {
  test("trims + collapses whitespace", () => {
    expect(normalizeText("  Jane   Doe ")).toBe("Jane Doe");
  });
  test("empty → undefined", () => {
    expect(normalizeText("   ")).toBeUndefined();
    expect(normalizeText(null)).toBeUndefined();
  });
});

describe("email normalization", () => {
  test("storage form lowercases + trims", () => {
    expect(normalizeEmailForStorage("  Jane@Acme.COM ")).toBe("jane@acme.com");
  });
  test("non-email → undefined", () => {
    expect(normalizeEmailForStorage("not-an-email")).toBeUndefined();
  });
  test("index form strips +tag so aliases dedupe", () => {
    expect(normalizeEmailForIndex("jane+sales@acme.com")).toBe("jane@acme.com");
  });
  test("index form keeps dots (not gmail-collapsed)", () => {
    expect(normalizeEmailForIndex("ja.ne@acme.com")).toBe("ja.ne@acme.com");
  });
  test("domain facet", () => {
    expect(emailDomainOf("jane@acme.com")).toBe("acme.com");
  });
});

describe("normalizeDomain", () => {
  test("strips scheme/www/path", () => {
    expect(normalizeDomain("https://www.Acme.com/about")).toBe("acme.com");
  });
  test("bare domain passes through lowercased", () => {
    expect(normalizeDomain("Acme.io")).toBe("acme.io");
  });
});

describe("linkedinPublicIdOf", () => {
  test("extracts slug from a profile URL", () => {
    expect(linkedinPublicIdOf("https://www.linkedin.com/in/Jane-Doe/")).toBe("jane-doe");
  });
  test("passes through a bare slug", () => {
    expect(linkedinPublicIdOf("jane-doe")).toBe("jane-doe");
  });
});
