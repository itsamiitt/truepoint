// accountRows.test.ts — the Accounts tab's merge/reduce seam (search-consolidation stage 2).
//
// Three properties matter here, and each one is a bug that would be invisible in review:
//   1. a workspace-only clause must SKIP the database half, never be silently dropped;
//   2. the merge must not render the same company twice when the two sides spell its domain differently;
//   3. a database row must be marked, or the grid claims the workspace holds companies it does not.
// Pure unit test — no DB, no DOM.

import { describe, expect, test } from "bun:test";
import { ACCOUNT_QUICK_FACETS } from "@/features/prospect/entries/accounts";
import type { AccountQuery, MaskedAccount, MaskedDatabaseCompany } from "@leadwolf/types";
import { databaseCompanyToRow, mergeAccountRows, toDatabaseCompanyQuery } from "./accountRows.ts";

const BASE: AccountQuery = { filters: [], sort: "relevance", limit: 50 };

function company(over: Partial<MaskedDatabaseCompany> = {}): MaskedDatabaseCompany {
  return {
    primaryDomain: "acme.com",
    name: "Acme",
    websiteUrl: null,
    logoUrl: null,
    description: null,
    linkedinCompanyUrl: null,
    industry: "Software",
    industryCode: null,
    industryLabel: null,
    employeeCount: 120,
    employeeBand: "51-200",
    revenueMinMinor: null,
    revenueMaxMinor: null,
    revenueCurrency: null,
    revenueDisplay: null,
    ownershipType: "private",
    yearFounded: 2010,
    specialties: [],
    hqCountry: "United States",
    hqCity: "Austin",
    updatedAt: "2026-08-20T00:00:00.000Z",
    inWorkspace: null,
    ...over,
  };
}

function account(over: Partial<MaskedAccount> = {}): MaskedAccount {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Acme",
    domain: "acme.com",
    industry: null,
    subIndustry: null,
    employeeCount: null,
    revenueRange: null,
    hqCountry: null,
    hqCity: null,
    technologies: [],
    fundingStage: null,
    companyStage: null,
    foundedYear: null,
    icpFitScore: null,
    contactCount: 3,
    revealedContactCount: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

describe("toDatabaseCompanyQuery", () => {
  test("passes through the facets the global graph can answer", () => {
    const q = toDatabaseCompanyQuery(
      {
        ...BASE,
        text: "acme",
        filters: [
          { kind: "term", field: "industry", op: "include", values: ["Software"] },
          { kind: "term", field: "employee_band", op: "include", values: ["51-200"] },
          { kind: "range", field: "employee_count", gte: 10 },
        ],
      },
      25,
    );
    expect(q).not.toBeNull();
    expect(q?.text).toBe("acme");
    expect(q?.filters).toHaveLength(3);
    expect(q?.limit).toBe(25);
  });

  test("preserves the exclude sense rather than flipping it to include", () => {
    // Dropping `op` here would show the user exactly the companies they asked to hide.
    const q = toDatabaseCompanyQuery(
      {
        ...BASE,
        filters: [{ kind: "term", field: "industry", op: "exclude", values: ["Retail"] }],
      },
      25,
    );
    expect(q?.filters[0]).toMatchObject({ kind: "term", op: "exclude", values: ["Retail"] });
  });

  test("returns null for a workspace-only clause instead of dropping it", () => {
    // These are all interrogations of the user's OWN book. Answering them against the global graph would
    // return companies that do not satisfy the filter the user actually typed.
    const workspaceOnly: AccountQuery["filters"][number][] = [
      { kind: "term", field: "technology", op: "include", values: ["salesforce"] },
      { kind: "term", field: "funding_stage", op: "include", values: ["series_a"] },
      { kind: "term", field: "revenue_range", op: "include", values: ["1M-10M"] },
      { kind: "range", field: "icp_fit_score", gte: 80 },
      { kind: "bool", field: "has_email", value: true },
    ];
    for (const clause of workspaceOnly) {
      expect(toDatabaseCompanyQuery({ ...BASE, filters: [clause] }, 25)).toBeNull();
    }
  });

  test("maps the overlay's created_desc onto a global order that means something", () => {
    // "recently added to MY workspace" is meaningless for a company the workspace does not hold.
    expect(toDatabaseCompanyQuery({ ...BASE, sort: "created_desc" }, 25)?.sort).toBe(
      "recently_updated",
    );
    expect(toDatabaseCompanyQuery({ ...BASE, sort: "name_asc" }, 25)?.sort).toBe("name_asc");
  });
});

describe("mergeAccountRows", () => {
  test("owned rows first, database rows after, each marked", () => {
    const rows = mergeAccountRows([account({ domain: "owned.com" })], [company()]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.databaseDomain).toBeUndefined();
    expect(rows[1]?.databaseDomain).toBe("acme.com");
  });

  test("does not render a company twice when the two sides differ only by case", () => {
    // accounts.domain is citext so the DB treats these as equal; the merge happens in JS, where it does not.
    const rows = mergeAccountRows(
      [account({ domain: "ACME.com" })],
      [company({ primaryDomain: "acme.com" })],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.databaseDomain).toBeUndefined();
  });

  test("drops a database hit the server already flagged as in-workspace", () => {
    const rows = mergeAccountRows(
      [],
      [
        company({
          inWorkspace: { accountId: "22222222-2222-4222-8222-222222222222", contactCount: 2 },
        }),
      ],
    );
    expect(rows).toHaveLength(0);
  });
});

describe("databaseCompanyToRow", () => {
  test("reports no technologies or funding rather than implying they are merely missing", () => {
    // Those Layer-0 subsystems have no production writer (0 rows). Rendering an empty value is honest;
    // rendering a hopeful placeholder would not be.
    const row = databaseCompanyToRow(company());
    expect(row.technologies).toEqual([]);
    expect(row.fundingStage).toBeNull();
    expect(row.companyStage).toBeNull();
  });

  test("carries zero workspace rollups — it is not in the workspace", () => {
    const row = databaseCompanyToRow(company());
    expect(row.contactCount).toBe(0);
    expect(row.revealedContactCount).toBe(0);
  });

  test("its synthetic id is namespaced so it can never be mistaken for a workspace uuid", () => {
    expect(databaseCompanyToRow(company()).id).toBe("db:acme.com");
  });
});

// ── The quick-tier promise (decisions.md 2026-08-25): every quick facet is one the global engine answers ──
describe("the Accounts quick tier never skips the database half", () => {
  test("a query from any quick facet still runs the global company search", () => {
    for (const facet of ACCOUNT_QUICK_FACETS) {
      const clause =
        facet.kind === "range"
          ? { kind: "range" as const, field: facet.field, gte: 1 }
          : { kind: "term" as const, field: facet.field, op: "include" as const, values: ["x"] };
      expect(toDatabaseCompanyQuery({ ...BASE, filters: [clause] }, 25)).not.toBeNull();
    }
  });
});
