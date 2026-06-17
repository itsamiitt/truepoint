// expandQuery.test.ts — proves a typed term expands to the matchable synonym set (the app-side
// `synonym_graph`), so "CEO" matches records stored as "Chief Executive Officer" (24 §4.3, ADR-0035).

import { describe, expect, test } from "bun:test";
import { expandTitleTerm } from "./expandQuery.ts";

describe("expandTitleTerm", () => {
  test("CEO expands to its canonical id + the spelled-out form among its synonyms", () => {
    const e = expandTitleTerm("CEO");
    expect(e.canonicalId).toBe("chief_executive_officer");
    expect(e.canonicalLabel).toBe("Chief Executive Officer");
    expect(e.synonyms).toContain("ceo");
    expect(e.synonyms).toContain("chief executive officer");
  });

  test("synonyms are normalized and de-duplicated", () => {
    const e = expandTitleTerm("Chief Executive Officer");
    expect(e.canonicalId).toBe("chief_executive_officer");
    expect(new Set(e.synonyms).size).toBe(e.synonyms.length);
    expect(e.synonyms.every((s) => s === s.toLowerCase())).toBe(true);
  });

  test("an unknown term passes through normalized with no canonical id", () => {
    const e = expandTitleTerm("Grand Vizier");
    expect(e.canonicalId).toBeNull();
    expect(e.canonicalLabel).toBeNull();
    expect(e.synonyms).toEqual(["grand vizier"]);
  });

  test("empty input yields no synonyms", () => {
    const e = expandTitleTerm("   ");
    expect(e.canonicalId).toBeNull();
    expect(e.synonyms).toEqual([]);
  });
});
