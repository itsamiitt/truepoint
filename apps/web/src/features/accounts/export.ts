// export.ts — a client-side CSV export of the Accounts grid (search-consolidation stage 5), the company
// twin of the prospect slice's masked-contact export.
//
// Companies carry NO PII — a firmographic row is name, domain, industry, headcount, revenue, location — so
// unlike the contact export there is nothing to mask here and no reveal boundary to respect. The one thing
// that IS worth being explicit about is provenance: a row from the platform database and a row from the
// user's own workspace look identical in a spreadsheet unless the file says which is which, so the export
// carries an "In workspace" column. Exporting a list that silently mixes the two would let someone believe
// they own 200 accounts when they own 12.
//
// Exports what is LOADED, matching the grid ("export what you see"). A whole-result-set export over a
// capped, keyset-paginated population is an export JOB, not a client-side blob — see async-jobs.
"use client";

import type { AccountRow } from "./accountRows";

/** RFC-4180 escape: quote a cell and double any embedded quotes. */
function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

const HEADERS = [
  "Company",
  "Domain",
  "Industry",
  "Headcount",
  "Revenue",
  "Founded",
  "HQ country",
  "HQ city",
  "Contacts",
  "In workspace",
];

function toRow(a: AccountRow): string {
  return [
    a.name,
    a.domain ?? "",
    a.industry ?? "",
    a.employeeCount ?? "",
    a.revenueRange ?? "",
    a.foundedYear ?? "",
    a.hqCountry ?? "",
    a.hqCity ?? "",
    // A database row has no workspace contacts by definition; printing 0 is the honest value, not a gap.
    a.contactCount,
    a.databaseDomain === undefined ? "yes" : "no",
  ]
    .map((v) => csvCell(String(v)))
    .join(",");
}

/** Build a CSV string for a set of account rows (header + one row each). Pure — unit-testable without the DOM. */
export function accountsCsv(rows: AccountRow[]): string {
  return [HEADERS.map(csvCell).join(","), ...rows.map(toRow)].join("\r\n");
}

/** Trigger a browser download of the Accounts CSV. Firmographic only; client-side. */
export function exportAccountsCsv(rows: AccountRow[], filename = "companies.csv"): void {
  const blob = new Blob([accountsCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
