// export.test.ts — the Accounts CSV export (search-consolidation stage 5).
//
// The property worth pinning is the PROVENANCE column. A workspace account and a platform-database company
// look identical in a spreadsheet, so a file that mixes them without saying which is which lets someone
// believe they own 200 accounts when they own 12. The rest is RFC-4180 escaping, which is the other thing
// CSV writers get quietly wrong.

import { describe, expect, test } from "bun:test";
import type { AccountRow } from "./accountRows.ts";
import { accountsCsv } from "./export.ts";

function row(over: Partial<AccountRow> = {}): AccountRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Acme",
    domain: "acme.com",
    industry: "Software",
    subIndustry: null,
    employeeCount: 120,
    revenueRange: "$1M-$10M",
    hqCountry: "United States",
    hqCity: "Austin",
    technologies: [],
    fundingStage: null,
    companyStage: null,
    foundedYear: 2010,
    icpFitScore: null,
    contactCount: 4,
    revealedContactCount: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

const lines = (csv: string) => csv.split("\r\n");

describe("accountsCsv", () => {
  test("says which rows the workspace actually owns", () => {
    const csv = accountsCsv([row(), row({ name: "Globex", databaseDomain: "globex.com" })]);
    const [, owned, database] = lines(csv);
    expect(owned).toContain('"yes"');
    expect(database).toContain('"no"');
  });

  test("a database row reports zero workspace contacts rather than a blank", () => {
    // Blank reads as "unknown"; 0 is the true value — a company not in the workspace has no contacts in it.
    const csv = accountsCsv([row({ databaseDomain: "globex.com", contactCount: 0 })]);
    expect(lines(csv)[1]).toContain('"0"');
  });

  test("escapes embedded quotes per RFC 4180 rather than breaking the row", () => {
    const csv = accountsCsv([row({ name: 'Acme "The Real One" Inc' })]);
    expect(lines(csv)[1]).toContain('"Acme ""The Real One"" Inc"');
    // Still exactly two lines — the quote did not terminate the field early.
    expect(lines(csv)).toHaveLength(2);
  });

  test("a comma in a value does not create a column", () => {
    const csv = accountsCsv([row({ hqCity: "Austin, TX" })]);
    const cells = lines(csv)[1]?.split('","') ?? [];
    expect(cells).toHaveLength(10); // the header's ten columns, not eleven
  });

  test("nulls render as empty cells, never as the string 'null'", () => {
    const csv = accountsCsv([
      row({
        domain: null,
        industry: null,
        employeeCount: null,
        revenueRange: null,
        foundedYear: null,
      }),
    ]);
    expect(lines(csv)[1]).not.toContain("null");
  });

  test("header comes first and an empty set still produces one", () => {
    expect(lines(accountsCsv([]))).toHaveLength(1);
    expect(accountsCsv([]).startsWith('"Company","Domain"')).toBe(true);
  });
});
