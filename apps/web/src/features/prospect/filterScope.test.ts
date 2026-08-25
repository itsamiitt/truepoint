// filterScope.test.ts — the "no dead controls, no silent narrowing" gate for both filter sidebars.
//
// Two classes of defect this pins, both of which shipped:
//
//   1. A control that changes nothing. "Do not contact" rendered, wrote a clause, and the search repository
//      dropped it on the floor — so a compliance filter silently returned the unfiltered list. A facet whose
//      field the backend does not implement must not be offered.
//   2. A control that silently deletes half the results. Thirteen of the twenty People controls made the
//      client skip the platform-database query, with nothing on screen connecting the two. Every facet now
//      declares a `scope`, the narrowing maps DERIVE from it, and the panes render a notice — so this test
//      guards the one thing that keeps those three in step: the declared scope must match what the
//      narrowing map actually does with a clause on that field.

import { describe, expect, test } from "bun:test";
import type { AccountQuery, ContactQuery } from "@leadwolf/types";
import {
  ACCOUNT_FILTER_GROUPS,
  accountFacetScope,
  accountWorkspaceOnlyFields,
} from "./accountFilterGroups.ts";
import { FILTER_GROUPS, facetScope, workspaceOnlyFields } from "./filterGroups.ts";

const PEOPLE_BASE: ContactQuery = { filters: [], sort: "relevance", limit: 50 };
const ACCOUNT_BASE: AccountQuery = { filters: [], sort: "relevance", limit: 50 };

const peopleFacets = FILTER_GROUPS.flatMap((g) => g.facets);
const accountFacets = ACCOUNT_FILTER_GROUPS.flatMap((g) => g.facets);

/** Build a minimal, valid clause for a facet so it can be pushed through the real narrowing map. */
function clauseFor(facet: (typeof peopleFacets)[number]): ContactQuery["filters"][number] {
  if (facet.kind === "bool") return { kind: "bool", field: facet.field, value: true };
  if (facet.kind === "range") return { kind: "range", field: facet.field, gte: 1 };
  return { kind: "term", field: facet.field, op: "include", values: ["x"] };
}

describe("people filter scopes", () => {
  test("every facet declares a scope", () => {
    for (const facet of peopleFacets) {
      expect(["both", "workspace-only"]).toContain(facet.scope);
    }
  });

  test("a facet field appears only once across all groups", () => {
    // Two controls writing the same clause is how the Accounts panel ended up with a "Revenue" control
    // bound to company_stage while company_stage ALSO had its own, correctly-labelled control.
    const fields = peopleFacets.map((f) => f.field);
    expect(new Set(fields).size).toBe(fields.length);
  });

  test("a workspace-only facet suppresses the database half, and names itself", () => {
    for (const facet of peopleFacets.filter((f) => f.scope === "workspace-only")) {
      const query: ContactQuery = { ...PEOPLE_BASE, filters: [clauseFor(facet)] };
      expect(workspaceOnlyFields(query)).toEqual([facet.field]);
    }
  });

  test("a `both` facet lets the database half run", () => {
    for (const facet of peopleFacets.filter((f) => f.scope === "both")) {
      const query: ContactQuery = { ...PEOPLE_BASE, filters: [clauseFor(facet)] };
      expect(workspaceOnlyFields(query)).toEqual([]);
    }
  });

  test("an unknown field is treated as workspace-only, never as safe to send", () => {
    expect(facetScope("something_invented")).toBe("workspace-only");
  });

  test("the fields the global people search actually accepts are the ones declared `both`", () => {
    // These five terms + two bools are what masterPersonSearchRepository can answer. If a facet is declared
    // `both` without the global engine supporting it, the client would send a filter that silently does
    // nothing there — the mirror image of the bug this file is about.
    const supported = new Set([
      "title",
      "company",
      "location",
      "seniority",
      "industry",
      "has_email",
      "has_phone",
    ]);
    for (const facet of peopleFacets.filter((f) => f.scope === "both")) {
      expect(supported.has(facet.field)).toBe(true);
    }
  });
});

describe("account filter scopes", () => {
  test("every facet declares a scope", () => {
    for (const facet of accountFacets) {
      expect(["both", "workspace-only"]).toContain(facet.scope);
    }
  });

  test("a facet field appears only once across all groups", () => {
    const fields = accountFacets.map((f) => f.field);
    expect(new Set(fields).size).toBe(fields.length);
  });

  test("the Revenue control filters on revenue_range, not company_stage", () => {
    // The shipped bug: a control labelled "Revenue" wrote a company_stage clause, so picking "Enterprise"
    // filtered by company stage under a Revenue heading — and the chip for a value chosen in the REAL
    // company-stage control came back labelled "Revenue" too, because facetLabel returns the first match.
    const revenue = accountFacets.find((f) => f.label === "Revenue");
    expect(revenue?.field).toBe("revenue_range");
    const stages = accountFacets.filter((f) => f.field === "company_stage");
    expect(stages).toHaveLength(1);
    expect(stages[0]?.label).toBe("Company stage");
  });

  test("a workspace-only facet suppresses the database half, and names itself", () => {
    for (const facet of accountFacets.filter((f) => f.scope === "workspace-only")) {
      const clause: AccountQuery["filters"][number] =
        facet.kind === "range"
          ? { kind: "range", field: facet.field, gte: 1 }
          : { kind: "term", field: facet.field, op: "include", values: ["x"] };
      expect(accountWorkspaceOnlyFields({ ...ACCOUNT_BASE, filters: [clause] })).toEqual([
        facet.field,
      ]);
    }
  });

  test("employee_band still crosses even though it has no sidebar control", () => {
    // A saved search or a shared URL can carry it, and the global company search filters on it directly.
    expect(accountFacetScope("employee_band")).toBe("both");
  });

  test("the fields the global company search actually accepts are the ones declared `both`", () => {
    const supported = new Set([
      "industry",
      "hq_country",
      "hq_city",
      "employee_band",
      "employee_count",
      "founded_year",
    ]);
    for (const facet of accountFacets.filter((f) => f.scope === "both")) {
      expect(supported.has(facet.field)).toBe(true);
    }
  });
});
