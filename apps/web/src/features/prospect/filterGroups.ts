// filterGroups.ts — the declarative model for the Apollo/ZoomInfo-style filter sidebar (24): the collapsible
// groups + their facets, and the pure, immutable helpers that read/update a server `ContactQuery` from UI
// interactions (multi-select within a facet = OR; across facets = AND, enforced server-side). The rebuilt
// FilterPanel renders from FILTER_GROUPS and calls these helpers; the removable pills + clear-all read
// `activeChips`. Pure module — no React/DOM — so it is fully unit-tested. Only contract-backed facets appear
// here (search.ts FacetKey/boolFilter/range); tags/lists, last-contacted channel, and job-change/hiring
// signals need contract/data extensions and are intentionally deferred (documented follow-ups).

import {
  type BoolFilterField,
  type ContactQuery,
  type FacetKey,
  type FilterClause,
  emailStatus,
  outreachStatus,
  seniorityLevel,
} from "@leadwolf/types";

export type TermOp = "include" | "exclude";

/** A selectable option for a fixed-enum term facet. */
export interface FacetOption {
  value: string;
  label: string;
}

/**
 * WHICH ENGINE a facet can actually be answered by. The Search grid merges two engines — the workspace
 * overlay and the global Layer-0 database — and most facets exist only on the overlay.
 *
 * This is not decoration. `databaseRows.toDatabaseQuery` DERIVES its narrowing from these values, so the
 * badge the sidebar shows and the query the client actually sends can never disagree; and because the field
 * is required, a new facet cannot be added without someone deciding which engines can serve it.
 *
 *   both           — the global graph carries this field too.
 *   workspace-only — an overlay-only signal (owner, outreach state, verification dates, ranges…). Applying
 *                    one means the user is interrogating their OWN pipeline, so the database half is
 *                    dropped rather than answered wrongly — and the pane now SAYS so.
 */
export type FacetScope = "both" | "workspace-only";

export type FacetDef = { scope: FacetScope } & (
  | {
      kind: "term";
      field: FacetKey;
      label: string;
      /** options = fixed enum chips; typeahead = high-cardinality (suggest); owner = teammate picker (+ Me). */
      input: "options" | "typeahead" | "owner";
      options?: FacetOption[];
    }
  | { kind: "bool"; field: BoolFilterField; label: string }
  | { kind: "range"; field: string; label: string; valueKind: "number" | "date"; unit?: string }
);

export interface FilterGroup {
  id: string;
  title: string;
  facets: FacetDef[];
}

/** Title-case a snake/space token: "c_suite" → "C Suite", "meeting_booked" → "Meeting Booked". */
function humanize(v: string): string {
  return v
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bC Suite\b/, "C-Suite");
}

const optionsOf = (values: readonly string[]): FacetOption[] =>
  values.map((v) => ({ value: v, label: humanize(v) }));

/**
 * How a record ENTERED this workspace (slice 7). Two classes, and the distinction is the whole point:
 *  • USER-DECLARED — a system the customer connected (their CRM) or their own manual/extension entry.
 *  • PLATFORM-SOURCED — anything TruePoint acquired (`linkedin_api`, `pdl`, `coresignal`, `coop`, `forge`).
 *    Which vendor the platform buys from is internal, so these are deliberately NOT offered as separate
 *    filter values; a record sourced that way reads as the TruePoint database, which is what it is.
 */
const SOURCE_FACET_OPTIONS: FacetOption[] = [
  { value: "manual", label: "Manual entry" },
  { value: "chrome_extension", label: "Browser extension" },
  { value: "database", label: "TruePoint database" },
  { value: "hubspot", label: "HubSpot" },
  { value: "salesforce", label: "Salesforce" },
  { value: "linkedin", label: "LinkedIn export" },
  { value: "sales_navigator", label: "Sales Navigator export" },
];

// ── The five groups (only contract-backed facets) ──────────────────────────────────────────────────────
export const FILTER_GROUPS: FilterGroup[] = [
  {
    id: "person",
    title: "Person",
    facets: [
      { kind: "term", field: "title", label: "Title", input: "typeahead", scope: "both" },
      {
        kind: "term",
        field: "seniority",
        label: "Seniority",
        input: "options",
        options: optionsOf(seniorityLevel.options),
        scope: "both",
      },
      {
        kind: "term",
        field: "department",
        label: "Department",
        input: "typeahead",
        scope: "workspace-only",
      },
      { kind: "term", field: "location", label: "Location", input: "typeahead", scope: "both" },
    ],
  },
  {
    id: "company",
    title: "Company",
    facets: [
      { kind: "term", field: "company", label: "Company", input: "typeahead", scope: "both" },
      { kind: "term", field: "industry", label: "Industry", input: "typeahead", scope: "both" },
      {
        kind: "term",
        field: "technology",
        label: "Technology",
        input: "typeahead",
        scope: "workspace-only",
      },
      {
        kind: "term",
        field: "funding_stage",
        label: "Funding stage",
        input: "typeahead",
        scope: "workspace-only",
      },
      {
        kind: "term",
        field: "company_stage",
        label: "Company stage",
        input: "typeahead",
        scope: "workspace-only",
      },
      {
        kind: "range",
        field: "headcount",
        label: "Headcount",
        valueKind: "number",
        scope: "workspace-only",
      },
      {
        kind: "range",
        field: "company_age",
        label: "Company age",
        valueKind: "number",
        unit: "yrs",
        scope: "workspace-only",
      },
    ],
  },
  {
    id: "engagement",
    title: "Engagement",
    facets: [
      {
        kind: "term",
        field: "outreach_status",
        label: "Status",
        input: "options",
        options: optionsOf(outreachStatus.options),
        scope: "workspace-only",
      },
      { kind: "term", field: "owner", label: "Owner", input: "owner", scope: "workspace-only" },
      {
        kind: "bool",
        field: "never_contacted",
        label: "Never contacted",
        scope: "workspace-only",
      },
      { kind: "bool", field: "do_not_contact", label: "Do not contact", scope: "workspace-only" },
      {
        kind: "range",
        field: "last_activity_at",
        label: "Last activity",
        valueKind: "date",
        scope: "workspace-only",
      },
    ],
  },
  {
    id: "data-signals",
    title: "Data signals",
    facets: [
      {
        kind: "term",
        field: "email_status",
        label: "Email status",
        input: "options",
        options: optionsOf(emailStatus.options),
        scope: "workspace-only",
      },
      { kind: "bool", field: "has_email", label: "Has email", scope: "both" },
      { kind: "bool", field: "has_phone", label: "Has phone", scope: "both" },
      { kind: "bool", field: "has_linkedin", label: "Has LinkedIn", scope: "workspace-only" },
      { kind: "bool", field: "complete", label: "Complete record", scope: "workspace-only" },
      { kind: "bool", field: "duplicate", label: "Likely duplicate", scope: "workspace-only" },
      // Supported by the search repository since the reveal work landed, but never offered in the sidebar —
      // "which of these have I already paid to reveal" is a question users had no way to ask.
      { kind: "bool", field: "is_revealed", label: "Already revealed", scope: "workspace-only" },
    ],
  },
  {
    id: "source",
    title: "Source & recency",
    facets: [
      {
        kind: "term",
        field: "source",
        label: "Source",
        input: "options",
        options: SOURCE_FACET_OPTIONS,
        scope: "workspace-only",
      },
      {
        kind: "range",
        field: "created_at",
        label: "Created",
        valueKind: "date",
        scope: "workspace-only",
      },
      {
        kind: "range",
        field: "score",
        label: "Score",
        valueKind: "number",
        scope: "workspace-only",
      },
    ],
  },
];

/** Every facet, flattened — the lookups below and the narrowing map both read this. */
const ALL_FACETS: FacetDef[] = FILTER_GROUPS.flatMap((g) => g.facets);

/**
 * Which engines can answer this field. Unknown fields are treated as workspace-only: the safe answer is to
 * drop the database half rather than to send a filter the global graph would ignore.
 */
export function facetScope(field: string): FacetScope {
  return ALL_FACETS.find((f) => f.field === field)?.scope ?? "workspace-only";
}

/** The fields on the ACTIVE query that the global database cannot answer, in sidebar order. */
export function workspaceOnlyFields(query: ContactQuery): string[] {
  const seen = new Set<string>();
  for (const clause of query.filters) {
    if (facetScope(clause.field) === "workspace-only") seen.add(clause.field);
  }
  return ALL_FACETS.filter((f) => seen.has(f.field)).map((f) => f.field);
}

/** Flat label lookup for a facet field (term/bool/range), for chips + headings. */
export function facetLabel(field: string): string {
  for (const g of FILTER_GROUPS) {
    for (const f of g.facets) if (f.field === field) return f.label;
  }
  return humanize(field);
}

function optionLabel(field: string, value: string): string {
  for (const g of FILTER_GROUPS) {
    for (const f of g.facets) {
      if (f.field === field && f.kind === "term" && f.options) {
        return f.options.find((o) => o.value === value)?.label ?? value;
      }
    }
  }
  return value;
}

// ── Immutable query helpers ─────────────────────────────────────────────────────────────────────────────
function isTerm(c: FilterClause, field: FacetKey, op: TermOp): boolean {
  return c.kind === "term" && c.field === field && c.op === op;
}

export function getTermValues(query: ContactQuery, field: FacetKey, op: TermOp): string[] {
  const c = query.filters.find((cl) => isTerm(cl, field, op));
  return c && c.kind === "term" ? c.values : [];
}

export function setTermValues(
  query: ContactQuery,
  field: FacetKey,
  op: TermOp,
  values: string[],
): ContactQuery {
  const filters = query.filters.filter((c) => !isTerm(c, field, op));
  if (values.length > 0) filters.push({ kind: "term", field, op, values });
  return { ...query, filters };
}

export function toggleTermValue(
  query: ContactQuery,
  field: FacetKey,
  op: TermOp,
  value: string,
): ContactQuery {
  const cur = getTermValues(query, field, op);
  const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
  return setTermValues(query, field, op, next);
}

// ── is/is-not multi-condition view (24 §2; one term field → an ARRAY of {type,value} conditions) ──────────
// A term field carries BOTH an include ("is") and an exclude ("is not") clause at once, so "Status is Active"
// and "Status is not Churned" coexist. These helpers present + edit that as a flat per-field condition list,
// keeping each value SINGLE-TYPED (adding/flipping moves a value between is/is-not, never duplicates it).

/** One is/is-not condition on a term field — a single UI row/tag. `op:"include"`=is, `op:"exclude"`=is not. */
export interface TermCondition {
  op: TermOp;
  value: string;
  label: string;
}

/** Every condition currently set on a term field (include first, then exclude), flattened for the UI. */
export function termConditions(query: ContactQuery, field: FacetKey): TermCondition[] {
  const out: TermCondition[] = [];
  for (const op of ["include", "exclude"] as const) {
    for (const value of getTermValues(query, field, op)) {
      out.push({ op, value, label: optionLabel(field, value) });
    }
  }
  return out;
}

const otherOp = (op: TermOp): TermOp => (op === "include" ? "exclude" : "include");

/** Add `value` as a condition of `op`, first removing it from the other op so a value is never both is + is-not. */
export function addTermCondition(
  query: ContactQuery,
  field: FacetKey,
  op: TermOp,
  value: string,
): ContactQuery {
  const cleared = setTermValues(
    query,
    field,
    otherOp(op),
    getTermValues(query, field, otherOp(op)).filter((v) => v !== value),
  );
  const cur = getTermValues(cleared, field, op);
  return cur.includes(value) ? cleared : setTermValues(cleared, field, op, [...cur, value]);
}

/** Remove one condition `(field, op, value)`. */
export function removeTermCondition(
  query: ContactQuery,
  field: FacetKey,
  op: TermOp,
  value: string,
): ContactQuery {
  return setTermValues(
    query,
    field,
    op,
    getTermValues(query, field, op).filter((v) => v !== value),
  );
}

/** Flip a condition's type (is ↔ is not) for one value, keeping it single-typed. */
export function flipTermCondition(
  query: ContactQuery,
  field: FacetKey,
  op: TermOp,
  value: string,
): ContactQuery {
  return addTermCondition(removeTermCondition(query, field, op, value), field, otherOp(op), value);
}

/** Count of active conditions/filters whose field belongs to a group (drives the collapsed-header badge). */
export function groupActiveCount(query: ContactQuery, fields: string[]): number {
  const set = new Set(fields);
  let n = 0;
  for (const c of query.filters) {
    if (!set.has(c.field)) continue;
    n += c.kind === "term" ? c.values.length : 1;
  }
  return n;
}

export function getBool(query: ContactQuery, field: BoolFilterField): boolean | undefined {
  const c = query.filters.find((cl) => cl.kind === "bool" && cl.field === field);
  return c && c.kind === "bool" ? c.value : undefined;
}

export function setBool(
  query: ContactQuery,
  field: BoolFilterField,
  value: boolean | undefined,
): ContactQuery {
  const filters = query.filters.filter((c) => !(c.kind === "bool" && c.field === field));
  if (value !== undefined) filters.push({ kind: "bool", field, value });
  return { ...query, filters };
}

export function getRange(query: ContactQuery, field: string): { gte?: number; lte?: number } {
  const c = query.filters.find((cl) => cl.kind === "range" && cl.field === field);
  return c && c.kind === "range" ? { gte: c.gte, lte: c.lte } : {};
}

export function setRange(
  query: ContactQuery,
  field: string,
  gte: number | undefined,
  lte: number | undefined,
): ContactQuery {
  const filters = query.filters.filter((c) => !(c.kind === "range" && c.field === field));
  if (gte !== undefined || lte !== undefined) {
    filters.push({
      kind: "range",
      field,
      ...(gte !== undefined ? { gte } : {}),
      ...(lte !== undefined ? { lte } : {}),
    });
  }
  return { ...query, filters };
}

/** Clear every filter (keeps the text query + sort). */
export function clearAllFilters(query: ContactQuery): ContactQuery {
  return { ...query, filters: [] };
}

/** Whether any filter is active (drives the clear-all affordance). */
export function hasActiveFilters(query: ContactQuery): boolean {
  return query.filters.length > 0;
}

/** A removable pill: a label + a pure remover that returns the query without that one selection. */
export interface ActiveChip {
  id: string;
  label: string;
  remove: (query: ContactQuery) => ContactQuery;
}

/** Every active selection as a removable chip (the pills row above the results). */
export function activeChips(query: ContactQuery): ActiveChip[] {
  const chips: ActiveChip[] = [];
  for (const c of query.filters) {
    if (c.kind === "term") {
      const prefix = c.op === "exclude" ? "Not " : "";
      for (const v of c.values) {
        chips.push({
          id: `t:${c.field}:${c.op}:${v}`,
          label: `${prefix}${facetLabel(c.field)}: ${optionLabel(c.field, v)}`,
          remove: (q) => toggleTermValue(q, c.field, c.op, v),
        });
      }
    } else if (c.kind === "bool") {
      chips.push({
        id: `b:${c.field}`,
        label: `${facetLabel(c.field)}: ${c.value ? "Yes" : "No"}`,
        remove: (q) => setBool(q, c.field, undefined),
      });
    } else {
      const parts = [
        c.gte !== undefined ? `≥ ${c.gte}` : null,
        c.lte !== undefined ? `≤ ${c.lte}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      chips.push({
        id: `r:${c.field}`,
        label: `${facetLabel(c.field)}: ${parts}`,
        remove: (q) => setRange(q, c.field, undefined, undefined),
      });
    }
  }
  return chips;
}
