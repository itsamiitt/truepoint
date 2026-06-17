// canonicalizeTitle.test.ts — proves the headline behaviour: a typed abbreviation resolves to the same
// canonical occupation as the spelled-out title, regardless of punctuation/spacing (24 §4, ADR-0035).

import { describe, expect, test } from "bun:test";
import { canonicalizeTitle } from "./canonicalizeTitle.ts";
import { normalizeTitle } from "./normalizeTitle.ts";

describe("normalizeTitle", () => {
  test("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalizeTitle("  C.E.O.  ")).toBe("ceo");
    expect(normalizeTitle("VP, Engineering")).toBe("vp engineering");
  });

  test("expands common contractions consistently", () => {
    expect(normalizeTitle("Sr Software Eng")).toBe("senior software engineering");
    expect(normalizeTitle("Ops Mgr")).toBe("operations manager");
  });

  test("returns empty string for punctuation-only input", () => {
    expect(normalizeTitle("—/—")).toBe("");
  });
});

describe("canonicalizeTitle", () => {
  test("CEO (abbreviation) → Chief Executive Officer", () => {
    const hit = canonicalizeTitle("CEO");
    expect(hit?.id).toBe("chief_executive_officer");
    expect(hit?.label).toBe("Chief Executive Officer");
    expect(hit?.seniority).toBe("c_suite");
    expect(hit?.jobFunction).toBe("executive");
  });

  test("the spelled-out form resolves to the SAME canonical as the abbreviation", () => {
    expect(canonicalizeTitle("Chief Executive Officer")?.id).toBe(canonicalizeTitle("CEO")?.id);
    expect(canonicalizeTitle("C.E.O.")?.id).toBe("chief_executive_officer");
  });

  test("resolves a range of abbreviations to their canonical occupation", () => {
    expect(canonicalizeTitle("cto")?.id).toBe("chief_technology_officer");
    expect(canonicalizeTitle("VP Eng")?.id).toBe("vp_engineering");
    expect(canonicalizeTitle("SDR")?.id).toBe("sales_development_representative");
    expect(canonicalizeTitle("swe")?.id).toBe("software_engineer");
  });

  test("returns null for a title not in the taxonomy", () => {
    expect(canonicalizeTitle("Grand Vizier of Vibes")).toBeNull();
    expect(canonicalizeTitle("   ")).toBeNull();
  });
});
