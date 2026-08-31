// columnRegistry.ts — WHICH columns each Search grid offers, and which of them are on by default.
//
// Pure data, deliberately separated from the two builders that render them (components/peopleColumns.tsx and
// components/AccountsTable.tsx). Two reasons:
//
//   1. The registry is the half worth pinning in a test — a chooser entry pointing at a key the grid never
//      builds, or two columns sharing a label, is exactly the defect that shipped the duplicate "Email"
//      header. The builders import `@/…`-aliased modules, which `bun test` cannot resolve from the repo
//      root, so keeping the data alias-free is what lets that test actually run.
//   2. Both panes now answer to a chooser, and the two registries read side by side here rather than being
//      buried at the top of a 250-line component.
//
// WHY MOST COLUMNS ARE OFF BY DEFAULT: the masked projections carry far more than either grid used to show,
// and all of it was simply unreachable. Every field is now a column the chooser can turn on, while the
// DEFAULT sets keep the resting grids readable (progressive disclosure, design Step 0.1). Turning a column
// on is one click; making a dozen columns the default would only move the unreadability.

export interface ToggleableColumn {
  key: string;
  label: string;
}

/** People: the toggleable columns, in render order. `select` and `actions` are always on. */
export const PEOPLE_TOGGLEABLE_COLUMNS: ToggleableColumn[] = [
  { key: "name", label: "Name" },
  { key: "company", label: "Company" },
  // Job title as its own column (2026-08-31 grid slimming) — it used to be a sub-line inside the Name cell,
  // which a compact row has no vertical room for.
  { key: "title", label: "Job title" },
  { key: "seniority", label: "Seniority" },
  { key: "department", label: "Department" },
  // The glyph column and the reveal column BOTH used to be headed "Email", one of them labelled "Address" in
  // the chooser — so the header and the menu disagreed about the same column. The glyph is a verification
  // verdict, the reveal cell is the address; each is now named for what it holds.
  { key: "email", label: "Email status" },
  { key: "address", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "lineType", label: "Line type" },
  { key: "location", label: "Location" },
  { key: "outreach", label: "Outreach" },
  { key: "health", label: "Data health" },
  { key: "verified", label: "Last verified" },
  { key: "created", label: "Added" },
  // Last on purpose: the LinkedIn link is the row's trailing affordance (2026-08-31 grid slimming).
  { key: "linkedin", label: "LinkedIn" },
];

/** People: the columns always rendered, never offered in the chooser. */
export const PEOPLE_ALWAYS_ON_COLUMNS = ["select", "actions"];

/** People: the resting column set (2026-08-31 grid slimming): name · company · job title · email · phone ·
 *  location · LinkedIn. Everything else is one chooser click away. */
export const PEOPLE_DEFAULT_VISIBLE_COLUMNS = [
  "name",
  "company",
  "title",
  "address",
  "phone",
  "location",
  "linkedin",
];

/** Accounts: the toggleable columns, in render order. `name` is always on. */
export const ACCOUNT_TOGGLEABLE_COLUMNS: ToggleableColumn[] = [
  { key: "industry", label: "Industry" },
  { key: "headcount", label: "Headcount" },
  { key: "revenue", label: "Revenue" },
  { key: "funding", label: "Funding / Stage" },
  { key: "subIndustry", label: "Sub-industry" },
  { key: "location", label: "HQ location" },
  { key: "technologies", label: "Technologies" },
  { key: "founded", label: "Founded" },
  { key: "icp", label: "ICP fit" },
  { key: "contacts", label: "Contacts" },
];

/** Accounts: the column always rendered — it is the row's identity. */
export const ACCOUNT_ALWAYS_ON_COLUMNS = ["name"];

/** Accounts: the resting column set — the five the grid has always shown. */
export const ACCOUNT_DEFAULT_VISIBLE_COLUMNS = [
  "industry",
  "headcount",
  "revenue",
  "funding",
  "contacts",
];
