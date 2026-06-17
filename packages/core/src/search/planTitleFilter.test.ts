// planTitleFilter.test.ts — proves a set of typed title values becomes a deduped, engine-agnostic match
// plan: known titles resolve to canonical ids (+ widen via synonyms); unknown ones fall back to text (24 §4).

import { describe, expect, test } from "bun:test";
import { planTitleFilter } from "./planTitleFilter.ts";

describe("planTitleFilter", () => {
  test("known abbreviations resolve to canonical ids", () => {
    const plan = planTitleFilter(["CEO", "CTO"]);
    expect(plan.canonicalIds).toContain("chief_executive_officer");
    expect(plan.canonicalIds).toContain("chief_technology_officer");
    expect(plan.synonyms).toContain("chief executive officer");
  });

  test("an unknown value falls back to its normalized text, no canonical id", () => {
    const plan = planTitleFilter(["Grand Vizier"]);
    expect(plan.canonicalIds).toEqual([]);
    expect(plan.synonyms).toContain("grand vizier");
  });

  test("canonical ids and synonyms are deduplicated across inputs", () => {
    const plan = planTitleFilter(["CEO", "chief executive officer", "C.E.O."]);
    expect(plan.canonicalIds).toEqual(["chief_executive_officer"]);
    expect(new Set(plan.synonyms).size).toBe(plan.synonyms.length);
  });

  test("mixed known + unknown yields both canonical ids and text synonyms", () => {
    const plan = planTitleFilter(["SDR", "Vibe Curator"]);
    expect(plan.canonicalIds).toContain("sales_development_representative");
    expect(plan.synonyms).toContain("vibe curator");
    expect(plan.terms).toHaveLength(2);
  });
});
