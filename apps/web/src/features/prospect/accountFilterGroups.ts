// accountFilterGroups.ts — the declarative model for the firmographic (company-level) filter sidebar: the
// collapsible groups + their facets, and the pure, immutable helpers that read/update a server `AccountQuery`
// from UI interactions (multi-select within a facet = OR; across facets = AND, enforced server-side). The
// AccountFilterPanel renders from ACCOUNT_FILTER_GROUPS and calls these helpers; the removable pills + clear-all
// read `activeChips`. This mirrors filterGroups.ts (the Contacts sibling) exactly in shape; the helpers are
// replicated (not imported) because the Contacts helpers are typed to ContactQuery/FacetKey, while these are
// typed to AccountQuery/AccountTermField. Pure module — no React/DOM — so it is fully unit-tested. Only
// contract-backed firmographic facets appear here (the `accounts` table columns kept in clear for faceting).

import type { AccountFilterClause, AccountQuery, AccountTermField } from "@leadwolf/types";

export type TermOp = "include" | "exclude";

/** A selectable option for a fixed-enum term facet. */
export interface FacetOption {
  value: string;
  label: string;
}

export type AccountFacetDef =
  | {
      kind: "term";
      field: AccountTermField;
      label: string;
      /** options = fixed enum chips; typeahead = high-cardinality (suggest). */
      input: "options" | "typeahead";
      options?: FacetOption[];
    }
  | { kind: "range"; field: string; label: string; valueKind: "number"; unit?: string };

export interface AccountFilterGroup {
  id: string;
  title: string;
  facets: AccountFacetDef[];
}

/** Title-case a snake/space token: "series_a" → "Series A", "mid_market" → "Mid Market". */
function humanize(v: string): string {
  return v
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bSeries ([a-z])\b/i, (_m, l: string) => `Series ${l.toUpperCase()}`);
}

const optionsOf = (values: readonly string[]): FacetOption[] =>
  values.map((v) => ({ value: v, label: humanize(v) }));

// Coarse firmographic enums kept in clear on `accounts` for faceting (funding_stage / company_stage). These are
// presentation chip sets; the server validates the actual values, so a value absent here still round-trips.
const FUNDING_STAGES = [
  "pre_seed",
  "seed",
  "series_a",
  "series_b",
  "series_c",
  "series_d",
  "growth",
  "public",
  "bootstrapped",
] as const;

const COMPANY_STAGES = ["startup", "smb", "mid_market", "enterprise"] as const;

// ── The five firmographic groups (only contract-backed facets) ──────────────────────────────────────────
export const ACCOUNT_FILTER_GROUPS: AccountFilterGroup[] = [
  {
    id: "industry",
    title: "Industry",
    facets: [
      { kind: "term", field: "industry", label: "Industry", input: "typeahead" },
      { kind: "term", field: "sub_industry", label: "Sub-industry", input: "typeahead" },
    ],
  },
  {
    id: "size",
    title: "Size & revenue",
    facets: [
      {
        kind: "range",
        field: "employee_count",
        label: "Employees",
        valueKind: "number",
      },
      {
        kind: "term",
        field: "company_stage",
        label: "Revenue",
        input: "options",
        options: optionsOf(COMPANY_STAGES),
      },
    ],
  },
  {
    id: "technographics",
    title: "Technographics",
    facets: [{ kind: "term", field: "technology", label: "Technology", input: "typeahead" }],
  },
  {
    id: "funding",
    title: "Funding & stage",
    facets: [
      {
        kind: "term",
        field: "funding_stage",
        label: "Funding stage",
        input: "options",
        options: optionsOf(FUNDING_STAGES),
      },
      {
        kind: "term",
        field: "company_stage",
        label: "Company stage",
        input: "options",
        options: optionsOf(COMPANY_STAGES),
      },
      { kind: "range", field: "founded_year", label: "Founded year", valueKind: "number" },
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
    id: "location",
    title: "Location",
    facets: [
      { kind: "term", field: "hq_country", label: "HQ country", input: "typeahead" },
      { kind: "term", field: "hq_city", label: "HQ city", input: "typeahead" },
    ],
  },
];

/** Flat label lookup for a facet field (term/range), for chips + headings. */
export function facetLabel(field: string): string {
  for (const g of ACCOUNT_FILTER_GROUPS) {
    for (const f of g.facets) if (f.field === field) return f.label;
  }
  return humanize(field);
}

function optionLabel(field: string, value: string): string {
  for (const g of ACCOUNT_FILTER_GROUPS) {
    for (const f of g.facets) {
      if (f.field === field && f.kind === "term" && f.options) {
        return f.options.find((o) => o.value === value)?.label ?? value;
      }
    }
  }
  return value;
}

// ── Immutable query helpers (the AccountQuery sibling of filterGroups.ts) ────────────────────────────────
function isTerm(c: AccountFilterClause, field: AccountTermField, op: TermOp): boolean {
  return c.kind === "term" && c.field === field && c.op === op;
}

export function getTermValues(query: AccountQuery, field: AccountTermField, op: TermOp): string[] {
  const c = query.filters.find((cl) => isTerm(cl, field, op));
  return c && c.kind === "term" ? c.values : [];
}

export function setTermValues(
  query: AccountQuery,
  field: AccountTermField,
  op: TermOp,
  values: string[],
): AccountQuery {
  const filters = query.filters.filter((c) => !isTerm(c, field, op));
  if (values.length > 0) {
    filters.push({ kind: "term", field, op, values });
  }
  return { ...query, filters };
}

export function toggleTermValue(
  query: AccountQuery,
  field: AccountTermField,
  op: TermOp,
  value: string,
): AccountQuery {
  const cur = getTermValues(query, field, op);
  const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
  return setTermValues(query, field, op, next);
}

// ── is/is-not multi-condition view (mirrors filterGroups.ts; a field → an array of {type,value} conditions) ──
/** One is/is-not condition on a term field (a UI row/tag). `op:"include"`=is, `op:"exclude"`=is not. */
export interface TermCondition {
  op: TermOp;
  value: string;
  label: string;
}

/** Every condition set on a term field (include first, then exclude), flattened for the UI. */
export function termConditions(query: AccountQuery, field: AccountTermField): TermCondition[] {
  const out: TermCondition[] = [];
  for (const op of ["include", "exclude"] as const) {
    for (const value of getTermValues(query, field, op)) {
      out.push({ op, value, label: optionLabel(field, value) });
    }
  }
  return out;
}

const otherOp = (op: TermOp): TermOp => (op === "include" ? "exclude" : "include");

/** Add `value` as a condition of `op`, removing it from the other op so a value is never both is + is-not. */
export function addTermCondition(
  query: AccountQuery,
  field: AccountTermField,
  op: TermOp,
  value: string,
): AccountQuery {
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
  query: AccountQuery,
  field: AccountTermField,
  op: TermOp,
  value: string,
): AccountQuery {
  return setTermValues(
    query,
    field,
    op,
    getTermValues(query, field, op).filter((v) => v !== value),
  );
}

/** Flip a condition's type (is ↔ is not) for one value, keeping it single-typed. */
export function flipTermCondition(
  query: AccountQuery,
  field: AccountTermField,
  op: TermOp,
  value: string,
): AccountQuery {
  return addTermCondition(removeTermCondition(query, field, op, value), field, otherOp(op), value);
}

/** Count of active conditions whose field belongs to a group (drives the collapsed-header badge). */
export function groupActiveCount(query: AccountQuery, fields: string[]): number {
  const set = new Set(fields);
  let n = 0;
  for (const c of query.filters) {
    if (!set.has(c.field)) continue;
    n += c.kind === "term" ? c.values.length : 1;
  }
  return n;
}

export function getRange(query: AccountQuery, field: string): { gte?: number; lte?: number } {
  const c = query.filters.find((cl) => cl.kind === "range" && cl.field === field);
  return c && c.kind === "range" ? { gte: c.gte, lte: c.lte } : {};
}

export function setRange(
  query: AccountQuery,
  field: string,
  gte: number | undefined,
  lte: number | undefined,
): AccountQuery {
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
export function clearAllFilters(query: AccountQuery): AccountQuery {
  return { ...query, filters: [] };
}

/** Whether any filter is active (drives the clear-all affordance). */
export function hasActiveFilters(query: AccountQuery): boolean {
  return query.filters.length > 0;
}

/** A removable pill: a label + a pure remover that returns the query without that one selection. */
export interface ActiveChip {
  id: string;
  label: string;
  remove: (query: AccountQuery) => AccountQuery;
}

/** Every active selection as a removable chip (the pills row above the results). */
export function activeChips(query: AccountQuery): ActiveChip[] {
  const chips: ActiveChip[] = [];
  for (const c of query.filters) {
    if (c.kind === "term") {
      const field = c.field;
      const prefix = c.op === "exclude" ? "Not " : "";
      for (const v of c.values) {
        chips.push({
          id: `t:${c.field}:${c.op}:${v}`,
          label: `${prefix}${facetLabel(c.field)}: ${optionLabel(c.field, v)}`,
          remove: (q) => toggleTermValue(q, field, c.op, v),
        });
      }
    } else if (c.kind === "range") {
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
    // bool clauses have no firmographic facets in ACCOUNT_FILTER_GROUPS; they are skipped (none are produced).
  }
  return chips;
}
