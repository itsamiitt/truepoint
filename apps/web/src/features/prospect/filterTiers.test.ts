// filterTiers.test.ts — the two-tier rail's one invariant (decisions.md 2026-08-25): a QUICK filter is
// answered by BOTH engines, so it can never make database people silently vanish, and everything under
// "All filters" searches one side only — the side its group declares. Plus: every quick-start preset is a
// valid query with at least one clause that runs the database half. (The scope declarations themselves are
// pinned by filterScope.test.ts; this file pins what the TIERS do with them.)
import { describe, expect, test } from "bun:test";
import { type ContactQuery, contactQuery } from "@leadwolf/types";
import { toDatabaseQuery } from "./databaseRows";
import {
  ALL_FILTER_GROUPS,
  FILTER_GROUPS,
  QUICK_FACETS,
  QUICK_START_PRESETS,
  facetScope,
} from "./filterGroups";

describe("the quick tier is exactly what both engines answer", () => {
  test("every quick facet is scoped to both engines", () => {
    for (const facet of QUICK_FACETS) {
      expect(facet.scope).toBe("both");
      expect(facetScope(facet.field)).toBe("both");
    }
  });

  test("a query built from ANY quick facet still runs the database half, dropping nothing", () => {
    for (const facet of QUICK_FACETS) {
      const clause =
        facet.kind === "bool"
          ? ({ kind: "bool", field: facet.field, value: true } as const)
          : ({ kind: "term", field: facet.field, op: "include", values: ["x"] } as const);
      const q: ContactQuery = { filters: [clause], sort: "relevance", limit: 50 } as ContactQuery;
      const { query, droppedFields } = toDatabaseQuery(q, 25);
      expect(query).not.toBeNull();
      expect(droppedFields).toEqual([]);
    }
  });

  test("every group under All filters declares one side, and every facet in it agrees", () => {
    // The group header's tag ("Workspace only" / "Database only") must be exactly true of everything under
    // it; a mixed group would make the tag a lie for half its controls.
    for (const group of ALL_FILTER_GROUPS) {
      const scope = group.scope;
      expect(scope).toBeDefined();
      expect(scope).not.toBe("both");
      for (const facet of group.facets) expect(facet.scope).toBe(scope ?? "both");
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
    const ids = new Set(QUICK_START_PRESETS.map((p) => p.id));
    expect(ids.size).toBe(QUICK_START_PRESETS.length);
    for (const p of QUICK_START_PRESETS) {
      const parsed = contactQuery.safeParse(p.query);
      expect(parsed.success).toBe(true);
      expect(p.query.filters.length).toBeGreaterThan(0);
      const { query, droppedFields } = toDatabaseQuery(p.query, 25);
      expect(query).not.toBeNull();
      expect(droppedFields).toEqual([]);
      expect(p.label.length).toBeGreaterThan(0);
    }
  });
});
