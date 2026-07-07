// countryToIso.test.ts — unit tests for the S-A3 best-effort freetext→ISO alpha-2 mapper (06 §3/§4 honesty).
// No DB. Proven: confident names/aliases map; already-ISO codes pass; case/space/punctuation tolerated;
// anything ambiguous/unknown/empty → null (never guessed — the value's location.country stays NULL, counted).

import { describe, expect, test } from "bun:test";
import { countryToIso } from "./countryToIso.ts";

describe("countryToIso — confident names + aliases", () => {
  test("full names", () => {
    expect(countryToIso("United States")).toBe("US");
    expect(countryToIso("United Kingdom")).toBe("GB");
    expect(countryToIso("Germany")).toBe("DE");
    expect(countryToIso("India")).toBe("IN");
  });

  test("common aliases resolve (incl. 2-letter aliases that are NOT their own code)", () => {
    expect(countryToIso("USA")).toBe("US");
    expect(countryToIso("UK")).toBe("GB"); // "UK" is not the ISO code (GB is) — the name table wins first
    expect(countryToIso("England")).toBe("GB");
    expect(countryToIso("Deutschland")).toBe("DE");
  });

  test("case / whitespace / trailing punctuation tolerated", () => {
    expect(countryToIso("  united states of america  ")).toBe("US");
    expect(countryToIso("U.S.A.")).toBe("US");
    expect(countryToIso("NETHERLANDS")).toBe("NL");
  });
});

describe("countryToIso — already-ISO codes", () => {
  test("a real 2-letter code passes through, uppercased", () => {
    expect(countryToIso("us")).toBe("US");
    expect(countryToIso("GB")).toBe("GB");
    expect(countryToIso("fr")).toBe("FR");
  });

  test("a 2-letter token that is NOT a known country code is rejected (never blind-trusted)", () => {
    expect(countryToIso("na")).toBeNull(); // "N/A" freetext, not Namibia — not in the curated set
    expect(countryToIso("ok")).toBeNull();
  });
});

describe("countryToIso — unmappable → null (06 §3 honesty)", () => {
  test("unknown / ambiguous / region-only / empty ⇒ null", () => {
    expect(countryToIso("Freedonia")).toBeNull();
    expect(countryToIso("EMEA")).toBeNull();
    expect(countryToIso("")).toBeNull();
    expect(countryToIso("   ")).toBeNull();
    expect(countryToIso(null)).toBeNull();
    expect(countryToIso(undefined)).toBeNull();
  });
});
