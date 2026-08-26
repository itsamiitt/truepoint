// filterTiers.test.ts — the two-tier rail's one invariant (decisions.md 2026-08-25): a QUICK filter is
// answered by BOTH engines, so it can never make database people silently vanish, and everything under
// "All filters" is genuinely saved-contacts-only. Plus: every quick-start preset is a valid query with at
// least one clause, and the inline notice names exactly the saved-only clauses.
import { describe, expect, test } from "bun:test";
import { type ContactQuery, contactQuery } from "@leadwolf/types";
import { toDatabaseQuery } from "./databaseRows";
import {
  ALL_FILTER_GROUPS,
  FILTER_GROUPS,
  QUICK_FACETS,
  QUICK_START_PRESETS,
  isWorkspaceOnlyField,
  workspaceOnlyChips,
} from "./filterGroups";

describe("the quick tier is exactly what both engines answer", () => {
  test("no quick facet is workspace-only", () => {
    for (const facet of QUICK_FACETS) expect(isWorkspaceOnlyField(facet.field)).toBe(false);
  });

  test("a query built from ANY quick facet still runs the database half", () => {
    for (const facet of QUICK_FACETS) {
      const clause =
        facet.kind === "bool"
          ? ({ kind: "bool", field: facet.field, value: true } as const)
          : ({ kind: "term", field: facet.field, op: "include", values: ["x"] } as const);
      const q: ContactQuery = { filters: [clause], sort: "relevance", limit: 50 } as ContactQuery;
      expect(toDatabaseQuery(q, 25)).not.toBeNull();
    }
  });

  test("every facet under All filters is saved-contacts-only (the tag is exact)", () => {
    for (const group of ALL_FILTER_GROUPS) {
      for (const facet of group.facets) expect(isWorkspaceOnlyField(facet.field)).toBe(true);
    }
  });

  test("the union sees every facet once, quick tier first", () => {
    expect(FILTER_GROUPS[0]?.id).toBe("quick");
    const fields = FILTER_GROUPS.flatMap((g) => g.facets.map((f) => `${f.kind}:${f.field}`));
    expect(new Set(fields).size).toBe(fields.length);
  });
});

describe("quick-start presets", () => {
  test("each is a valid contact query with at least one clause, and runs the database half", () => {
    expect(QUICK_START_PRESETS.length).toBeGreaterThanOrEqual(3);
    for (const p of QUICK_START_PRESETS) {
      const parsed = contactQuery.safeParse(p.query);
      expect(parsed.success).toBe(true);
      expect(p.query.filters.length).toBeGreaterThan(0);
      expect(toDatabaseQuery(p.query, 25)).not.toBeNull();
      expect(p.label.length).toBeGreaterThan(0);
    }
  });
});

describe("workspaceOnlyChips — what the notice names", () => {
  test("names only the saved-only clauses, and removing them all restores the database half", () => {
    const q: ContactQuery = {
      filters: [
        { kind: "term", field: "title", op: "include", values: ["VP"] },
        { kind: "term", field: "outreach_status", op: "include", values: ["new"] },
        { kind: "range", field: "score", gte: 50 },
      ],
      sort: "relevance",
      limit: 50,
    } as ContactQuery;
    const chips = workspaceOnlyChips(q);
    expect(chips.map((c) => c.field)).toEqual(["outreach_status", "score"]);
    expect(chips.map((c) => c.facet)).toEqual(["Status", "Score"]);
    expect(toDatabaseQuery(q, 25)).toBeNull();
    const cleared = chips.reduce((acc, c) => c.remove(acc), q);
    expect(toDatabaseQuery(cleared, 25)).not.toBeNull();
    expect(cleared.filters).toHaveLength(1);
  });
});
