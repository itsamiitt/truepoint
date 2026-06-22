// filterGroups.test.ts — the pure filter-model helpers (24): multi-select toggle, include vs exclude as
// independent clauses, tri-state bool, range set/clear, removable chips, and clear-all. No DB/DOM.

import { describe, expect, test } from "bun:test";
import type { ContactQuery } from "@leadwolf/types";
import {
  activeChips,
  clearAllFilters,
  getBool,
  getRange,
  getTermValues,
  hasActiveFilters,
  setBool,
  setRange,
  toggleTermValue,
} from "./filterGroups.ts";

const base: ContactQuery = { filters: [], sort: "relevance", limit: 50 };

describe("filterGroups helpers", () => {
  test("toggle adds then removes a term value (multi-select within a facet)", () => {
    let q = toggleTermValue(base, "seniority", "include", "vp");
    q = toggleTermValue(q, "seniority", "include", "director");
    expect(getTermValues(q, "seniority", "include").sort()).toEqual(["director", "vp"]);
    q = toggleTermValue(q, "seniority", "include", "vp");
    expect(getTermValues(q, "seniority", "include")).toEqual(["director"]);
  });

  test("include and exclude on the same facet are independent clauses (negative filters)", () => {
    let q = toggleTermValue(base, "industry", "include", "Software");
    q = toggleTermValue(q, "industry", "exclude", "Retail");
    expect(getTermValues(q, "industry", "include")).toEqual(["Software"]);
    expect(getTermValues(q, "industry", "exclude")).toEqual(["Retail"]);
    expect(q.filters).toHaveLength(2);
  });

  test("bool is tri-state: true → false → cleared", () => {
    let q = setBool(base, "has_email", true);
    expect(getBool(q, "has_email")).toBe(true);
    q = setBool(q, "has_email", false);
    expect(getBool(q, "has_email")).toBe(false);
    q = setBool(q, "has_email", undefined);
    expect(getBool(q, "has_email")).toBeUndefined();
    expect(q.filters).toHaveLength(0);
  });

  test("range set replaces, and clear removes", () => {
    let q = setRange(base, "score", 70, undefined);
    expect(getRange(q, "score")).toEqual({ gte: 70, lte: undefined });
    q = setRange(q, "score", 80, 95);
    expect(getRange(q, "score")).toEqual({ gte: 80, lte: 95 });
    q = setRange(q, "score", undefined, undefined);
    expect(getRange(q, "score")).toEqual({});
  });

  test("activeChips lists every selection and each chip removes exactly itself", () => {
    let q = toggleTermValue(base, "seniority", "include", "vp");
    q = toggleTermValue(q, "seniority", "include", "director");
    q = setBool(q, "has_phone", true);
    q = setRange(q, "headcount", 50, 500);
    const chips = activeChips(q);
    expect(chips).toHaveLength(4); // 2 term values + 1 bool + 1 range

    const vpChip = chips.find((c) => c.label.includes("Vp") || c.label.includes("Director"));
    expect(vpChip).toBeDefined();
    // Removing one term value leaves the other selections intact.
    const after = vpChip ? vpChip.remove(q) : q;
    expect(getTermValues(after, "seniority", "include")).toHaveLength(1);
    expect(getBool(after, "has_phone")).toBe(true);
  });

  test("clearAllFilters drops filters but keeps text + sort", () => {
    let q: ContactQuery = { ...base, text: "growth", sort: "score_desc" };
    q = setBool(q, "duplicate", true);
    expect(hasActiveFilters(q)).toBe(true);
    const cleared = clearAllFilters(q);
    expect(cleared.filters).toEqual([]);
    expect(cleared.text).toBe("growth");
    expect(cleared.sort).toBe("score_desc");
    expect(hasActiveFilters(cleared)).toBe(false);
  });
});
