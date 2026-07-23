import { describe, expect, test } from "bun:test";
import {
  emailDomainOf,
  linkedinPublicIdOf,
  normalizeDomain,
  normalizeEmailForIndex,
  normalizeEmailForStorage,
  normalizeText,
} from "../src/normalize.ts";

describe("normalizeEmailForStorage", () => {
  test("trims and lowercases", () => {
    expect(normalizeEmailForStorage("  Jane.Doe@Example.COM ")).toBe("jane.doe@example.com");
  });
  test("undefined for empty / non-email / null", () => {
    expect(normalizeEmailForStorage("   ")).toBeUndefined();
    expect(normalizeEmailForStorage("not-an-email")).toBeUndefined();
    expect(normalizeEmailForStorage(null)).toBeUndefined();
  });
});

describe("normalizeEmailForIndex", () => {
  test("strips the local-part +tag but keeps the domain", () => {
    expect(normalizeEmailForIndex("jane+newsletter@example.com")).toBe("jane@example.com");
  });
  test("does NOT strip dots (gmail-only, would merge distinct identities)", () => {
    expect(normalizeEmailForIndex("jane.doe@example.com")).toBe("jane.doe@example.com");
  });
  test("passes through an address with no +tag", () => {
    expect(normalizeEmailForIndex("jane@example.com")).toBe("jane@example.com");
  });
});

describe("emailDomainOf", () => {
  test("returns the domain", () => {
    expect(emailDomainOf("jane@example.com")).toBe("example.com");
  });
});

describe("normalizeDomain", () => {
  test("strips scheme, www, and path", () => {
    expect(normalizeDomain("https://www.Example.com/careers")).toBe("example.com");
  });
  test("undefined when there is no dot", () => {
    expect(normalizeDomain("localhost")).toBeUndefined();
  });
});

describe("linkedinPublicIdOf", () => {
  test("extracts the slug from a profile URL and lowercases", () => {
    expect(linkedinPublicIdOf("https://www.linkedin.com/in/Jane-Doe-123/")).toBe("jane-doe-123");
  });
  test("passes through a bare slug", () => {
    expect(linkedinPublicIdOf("jane-doe-123")).toBe("jane-doe-123");
  });
});

describe("normalizeText", () => {
  test("collapses internal whitespace", () => {
    expect(normalizeText("  a   b  ")).toBe("a b");
  });
});
