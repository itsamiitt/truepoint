// filterGroups.ts — the declarative model for the Apollo/ZoomInfo-style filter sidebar (24): the collapsible
// groups + their facets, and the pure, immutable helpers that read/update a server `ContactQuery` from UI
// interactions (multi-select within a facet = OR; across facets = AND, enforced server-side). The rebuilt
// FilterRail renders from FILTER_GROUPS and calls these helpers; the removable pills + clear-all read
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
  sourceName,
} from "@leadwolf/types";

export type TermOp = "include" | "exclude";

/** A selectable option for a fixed-enum term facet. */
export interface FacetOption {
  value: string;
  label: string;
}

export type FacetDef =
  | {
      kind: "term";
      field: FacetKey;
      label: string;
      /** options = fixed enum chips; typeahead = high-cardinality (suggest); owner = teammate picker (+ Me). */
      input: "options" | "typeahead" | "owner";
      options?: FacetOption[];
    }
  | { kind: "bool"; field: BoolFilterField; label: string }
  | { kind: "range"; field: string; label: string; valueKind: "number" | "date"; unit?: string };

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

// ── The five groups (only contract-backed facets) ──────────────────────────────────────────────────────
export const FILTER_GROUPS: FilterGroup[] = [
  {
    id: "person",
    title: "Person",
    facets: [
      { kind: "term", field: "title", label: "Title", input: "typeahead" },
      {
        kind: "term",
        field: "seniority",
        label: "Seniority",
        input: "options",
        options: optionsOf(seniorityLevel.options),
      },
      { kind: "term", field: "department", label: "Department", input: "typeahead" },
      { kind: "term", field: "location", label: "Location", input: "typeahead" },
    ],
  },
  {
    id: "company",
    title: "Company",
    facets: [
      { kind: "term", field: "company", label: "Company", input: "typeahead" },
      { kind: "term", field: "industry", label: "Industry", input: "typeahead" },
      { kind: "term", field: "technology", label: "Technology", input: "typeahead" },
      { kind: "term", field: "funding_stage", label: "Funding stage", input: "typeahead" },
      { kind: "term", field: "company_stage", label: "Company stage", input: "typeahead" },
      { kind: "range", field: "headcount", label: "Headcount", valueKind: "number" },
      {
        kind: "range",
        field: "company_age",
        label: "Company age",
        valueKind: "number",
        unit: "yrs",
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
      },
      { kind: "term", field: "owner", label: "Owner", input: "owner" },
      { kind: "bool", field: "never_contacted", label: "Never contacted" },
      { kind: "bool", field: "do_not_contact", label: "Do not contact" },
      { kind: "range", field: "last_activity_at", label: "Last activity", valueKind: "date" },
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
      },
      { kind: "bool", field: "has_email", label: "Has email" },
      { kind: "bool", field: "has_phone", label: "Has phone" },
      { kind: "bool", field: "has_linkedin", label: "Has LinkedIn" },
      { kind: "bool", field: "complete", label: "Complete record" },
      { kind: "bool", field: "duplicate", label: "Likely duplicate" },
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
        options: optionsOf(sourceName.options),
      },
      { kind: "range", field: "created_at", label: "Created", valueKind: "date" },
      { kind: "range", field: "score", label: "Score", valueKind: "number" },
    ],
  },
];

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
