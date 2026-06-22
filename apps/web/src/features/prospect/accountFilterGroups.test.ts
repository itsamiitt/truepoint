// accountFilterGroups.test.ts — the pure firmographic filter-model helpers (the Accounts sibling of
// filterGroups.test.ts): multi-select toggle, include vs exclude as independent clauses, range set/clear,
// removable chips, and clear-all. No DB/DOM.

import { describe, expect, test } from "bun:test";
import type { AccountQuery } from "@leadwolf/types";
import {
  ACCOUNT_FILTER_GROUPS,
  activeChips,
  clearAllFilters,
  facetLabel,
  getRange,
  getTermValues,
  hasActiveFilters,
  setRange,
  toggleTermValue,
} from "./accountFilterGroups.ts";

const base: AccountQuery = { filters: [], sort: "relevance", limit: 50 };

describe("accountFilterGroups model", () => {
  test("ACCOUNT_FILTER_GROUPS covers the five firmographic groups + their facet fields", () => {
    const ids = ACCOUNT_FILTER_GROUPS.map((g) => g.id);
    expect(ids).toEqual(["industry", "size", "technographics", "funding", "location"]);
    const fields = ACCOUNT_FILTER_GROUPS.flatMap((g) => g.facets.map((f) => f.field));
    for (const required of [
      "industry",
      "employee_count",
      "technology",
      "funding_stage",
      "company_stage",
      "founded_year",
      "hq_country",
      "hq_city",
    ]) {
      expect(fields).toContain(required);
    }
  });
});

describe("accountFilterGroups helpers", () => {
  test("toggle adds then removes a term value (multi-select within a facet)", () => {
    let q = toggleTermValue(base, "industry", "include", "Software");
    q = toggleTermValue(q, "industry", "include", "Fintech");
    expect(getTermValues(q, "industry", "include").sort()).toEqual(["Fintech", "Software"]);
    q = toggleTermValue(q, "industry", "include", "Software");
    expect(getTermValues(q, "industry", "include")).toEqual(["Fintech"]);
  });

  test("include and exclude on the same facet are independent clauses (negative filters)", () => {
    let q = toggleTermValue(base, "technology", "include", "salesforce");
    q = toggleTermValue(q, "technology", "exclude", "hubspot");
    expect(getTermValues(q, "technology", "include")).toEqual(["salesforce"]);
    expect(getTermValues(q, "technology", "exclude")).toEqual(["hubspot"]);
    expect(q.filters).toHaveLength(2);
  });

  test("range set replaces, and clear removes", () => {
    let q = setRange(base, "employee_count", 50, undefined);
    expect(getRange(q, "employee_count")).toEqual({ gte: 50, lte: undefined });
    q = setRange(q, "employee_count", 100, 5000);
    expect(getRange(q, "employee_count")).toEqual({ gte: 100, lte: 5000 });
    q = setRange(q, "employee_count", undefined, undefined);
    expect(getRange(q, "employee_count")).toEqual({});
  });

  test("activeChips lists every selection and each chip removes exactly itself", () => {
    let q = toggleTermValue(base, "industry", "include", "Software");
    q = toggleTermValue(q, "industry", "include", "Fintech");
    q = setRange(q, "employee_count", 50, 500);
    const chips = activeChips(q);
    expect(chips).toHaveLength(3); // 2 term values + 1 range

    const swChip = chips.find((c) => c.label.includes("Software"));
    expect(swChip).toBeDefined();
    // Removing one term value leaves the other selections intact.
    const after = swChip ? swChip.remove(q) : q;
    expect(getTermValues(after, "industry", "include")).toEqual(["Fintech"]);
    expect(getRange(after, "employee_count")).toEqual({ gte: 50, lte: 500 });
  });

  test("range chip removes the whole range clause", () => {
    const q = setRange(base, "founded_year", 2010, 2020);
    const chips = activeChips(q);
    expect(chips).toHaveLength(1);
    const cleared = chips[0]!.remove(q);
    expect(getRange(cleared, "founded_year")).toEqual({});
  });

  test("clearAllFilters drops filters but keeps text + sort", () => {
    let q: AccountQuery = { ...base, text: "saas", sort: "headcount_desc" };
    q = toggleTermValue(q, "funding_stage", "include", "series_a");
    expect(hasActiveFilters(q)).toBe(true);
    const cleared = clearAllFilters(q);
    expect(cleared.filters).toEqual([]);
    expect(cleared.text).toBe("saas");
    expect(cleared.sort).toBe("headcount_desc");
    expect(hasActiveFilters(cleared)).toBe(false);
  });

  test("facetLabel resolves known fields and humanizes unknown ones", () => {
    expect(facetLabel("industry")).toBe("Industry");
    expect(facetLabel("funding_stage")).toBe("Funding stage");
    expect(facetLabel("some_unknown_field")).toBe("Some Unknown Field");
  });

  test("option chips render their humanized label, not the raw enum value", () => {
    const q = toggleTermValue(base, "funding_stage", "include", "series_a");
    const chip = activeChips(q)[0]!;
    expect(chip.label).toBe("Funding stage: Series A");
  });
});
