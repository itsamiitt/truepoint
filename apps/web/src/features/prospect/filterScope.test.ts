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
import {
  FILTER_GROUPS,
  databaseOnlyFields,
  facetScope,
  workspaceOnlyFields,
} from "./filterGroups.ts";

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
      expect(["both", "workspace-only", "database-only"]).toContain(facet.scope);
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
    // The fail-closed direction: an unrecognised field must never be assumed answerable by the global
    // engine, and must never be collected as database-only either (which would skip the workspace half
    // for a field nothing can serve).
    expect(facetScope("something_invented")).toBe("workspace-only");
    const q: ContactQuery = {
      ...PEOPLE_BASE,
      filters: [
        { kind: "term", field: "something_invented" as never, op: "include", values: ["x"] },
      ],
    };
    expect(databaseOnlyFields(q)).toEqual([]);
  });

  test("a database-only facet skips the WORKSPACE half, and only that half", () => {
    // The mirror of the workspace-only case. These are Layer-0 satellite facts; the overlay's role is
    // REVOKEd from every master_* table, so asking it is a privilege denial, not an empty result.
    for (const facet of peopleFacets.filter((f) => f.scope === "database-only")) {
      const query: ContactQuery = { ...PEOPLE_BASE, filters: [clauseFor(facet)] };
      expect(databaseOnlyFields(query)).toEqual([facet.field]);
      // …and it must NOT also suppress the database half, or the grid would show nothing at all.
      expect(workspaceOnlyFields(query)).toEqual([]);
    }
  });

  test("the satellite facets are declared database-only, not `both`", () => {
    // Declaring one `both` would send it to the workspace engine, which has no clause for it and would
    // silently return the unfiltered list — the exact defect class the scope model exists to prevent.
    const byField = new Map(peopleFacets.map((f) => [f.field, f.scope]));
    for (const field of ["skill", "school", "field_of_study", "language", "past_company"]) {
      expect(byField.get(field)).toBe("database-only");
    }
  });

  test("past employer is distinct from the current-employer facet", () => {
    // `company` reads master_persons.current_company_id; `past_company` walks the whole employment history.
    // Collapsing them would silently turn "ex-Stripe people" into "people at Stripe now".
    const byField = new Map(peopleFacets.map((f) => [f.field, f.scope]));
    expect(byField.get("company")).toBe("both");
    expect(byField.get("past_company")).toBe("database-only");
  });

  test("the outcome-driven filters are all offered", () => {
    const fields = peopleFacets.map((f) => f.field);
    // Each is a named target outcome that had no control at all before.
    expect(fields).toContain("phone_line_type"); // [S-04] mobile-vs-landline, pre-reveal, TCPA-relevant
    expect(fields).toContain("last_verified_at"); // [S-10] verification recency
    expect(fields).toContain("job_change_at"); // [S-13] who has moved recently
    expect(fields).toContain("is_revealed");
  });

  test("no `do_not_contact` control — this surface cannot answer it in either direction", () => {
    // searchRepository.buildWhere excludes suppressed contacts from every search, count and facet query at
    // one chokepoint, so "on the DNC list" is unsatisfiable here and "not on the DNC list" is already true
    // of every row. The control shipped for months writing a clause the repository dropped (returning the
    // unfiltered list); implementing that clause as written returns zero rows instead. Neither is a filter.
    expect(peopleFacets.map((f) => f.field)).not.toContain("do_not_contact");
  });

  test("an undeclared field still suppresses the database half — the guard fails CLOSED", () => {
    // A field with no sidebar control can still reach this: a saved search or a shared ?f= URL carries
    // whatever validated when it was written, and the contract enum outlives any one panel. This function
    // is the ONLY thing standing between such a clause and the global query, which would reject it with a
    // 400 rather than skipping cleanly.
    //
    // `skill` used to be the live example — declared in FacetKey, implemented nowhere, offered by no
    // control. It has since graduated to a real database-only facet, which is why this now uses a synthetic
    // field: the property is about UNKNOWN fields, and it must keep holding when every known one is wired.
    const query: ContactQuery = {
      ...PEOPLE_BASE,
      filters: [{ kind: "term", field: "retired_facet" as never, op: "include", values: ["x"] }],
    };
    expect(workspaceOnlyFields(query)).toEqual(["retired_facet"]);
  });

  test("the job-change filter is a job-change filter, not a signal filter", () => {
    // intent_signals also holds web_visit / keyword_search / content_engagement — third-party behavioural
    // intent, which is X-04, a DEFERRED NON-GOAL. This facet reads only job-change detections, and the
    // repository's subquery is scoped to signal_type='job_change' to match. If a general "signal recency"
    // facet ever appears here, it needs a recorded decision first — not a quiet widening of this one.
    //
    // The permission and its limit are recorded: docs/strategy/decisions.md, open-decision register entry 8
    // (2026-08-25). This is the CLIENT half of the guard — it stops the control appearing. The SQL half is
    // packages/db/src/searchIntentScope.test.ts, which stops the query widening underneath a control that
    // already exists. Neither catches the other's failure mode, so both stay.
    const signalish = peopleFacets.filter(
      (f) => f.field.includes("signal") || f.field.includes("intent"),
    );
    expect(signalish).toEqual([]);
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

  test("every database-only field is one masterPersonSearchRepository can answer", () => {
    // The mirror of the `both` check above: a database-only facet the global engine has no clause for
    // would send a field its Zod contract rejects, turning a filter into a 400.
    const supported = new Set(["skill", "language", "school", "field_of_study", "past_company"]);
    for (const facet of peopleFacets.filter((f) => f.scope === "database-only")) {
      expect(supported.has(facet.field)).toBe(true);
    }
  });
});

describe("account filter scopes", () => {
  test("every facet declares a scope", () => {
    for (const facet of accountFacets) {
      expect(["both", "workspace-only", "database-only"]).toContain(facet.scope);
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
