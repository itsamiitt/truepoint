// accountFilterGroups.ts — the declarative model for the firmographic (company-level) filter rail: the facets
// in their two tiers — QUICK (always visible) and "All filters" (accordion groups) — and the pure, immutable
// helpers that read/update a server `AccountQuery` from UI interactions (multi-select within a facet = OR;
// across facets = AND, enforced server-side). The AccountFilterPanel renders from ACCOUNT_QUICK_FACETS +
// ACCOUNT_ALL_FILTER_GROUPS and calls these helpers; the removable pills + clear-all read `activeChips`. This
// mirrors filterGroups.ts (the Contacts sibling) exactly in shape; the helpers are replicated (not imported)
// because the Contacts helpers are typed to ContactQuery/FacetKey, while these are typed to
// AccountQuery/AccountTermField. Pure module — no React/DOM — so it is fully unit-tested. Only
// contract-backed firmographic facets appear here (the `accounts` table columns kept in clear for faceting).
//
// THE TIER RULE is the same as the People rail's (decisions.md 2026-08-25): a QUICK facet is one BOTH
// engines answer (`scope: "both"`), so a first filter never makes the global companies silently vanish;
// everything workspace-only lives under "All filters", tagged.

import type { AccountFilterClause, AccountQuery, AccountTermField } from "@leadwolf/types";

export type TermOp = "include" | "exclude";

/** A selectable option for a fixed-enum term facet. */
export interface FacetOption {
  value: string;
  label: string;
}

/**
 * WHICH ENGINE a facet can be answered by — see the same type in filterGroups.ts for the full reasoning.
 * `accountRows.toDatabaseCompanyQuery` derives its narrowing from these values, so the badge the sidebar
 * shows and the query the client sends cannot drift apart. The tier a facet sits in derives from it too.
 */
export type AccountFacetScope = "both" | "workspace-only";

export type AccountFacetDef = { scope: AccountFacetScope } & (
  | {
      kind: "term";
      field: AccountTermField;
      label: string;
      /**
       * options   = fixed enum chips
       * typeahead = high-cardinality, server suggest
       * counts    = options discovered from the live facet counts. For a field that is a free-text DISPLAY
       *             string (revenue_range is built by revenueDisplay(), not an enum) and has no suggest
       *             endpoint, the counts ARE the option list — and it can only offer values that exist.
       */
      input: "options" | "typeahead" | "counts";
      options?: FacetOption[];
      /** An EXAMPLE of the input ("e.g. Software") for a free-text or typeahead facet. */
      placeholder?: string;
    }
  | { kind: "range"; field: string; label: string; valueKind: "number"; unit?: string }
);

export interface AccountFilterGroup {
  id: string;
  title: string;
  facets: AccountFacetDef[];
  /** What EVERY facet in the group searches — the tier tag on the group header. */
  scope?: AccountFacetScope;
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

// ── Tier 1: QUICK filters — exactly the facets the global company graph answers too ─────────────────────
export const ACCOUNT_QUICK_FACETS: AccountFacetDef[] = [
  {
    kind: "term",
    field: "industry",
    label: "Industry",
    input: "typeahead",
    placeholder: "e.g. Software",
    scope: "both",
  },
  {
    kind: "term",
    field: "hq_country",
    label: "HQ country",
    input: "typeahead",
    placeholder: "e.g. India",
    scope: "both",
  },
  {
    kind: "term",
    field: "hq_city",
    label: "HQ city",
    input: "typeahead",
    placeholder: "e.g. Bengaluru",
    scope: "both",
  },
  {
    kind: "range",
    field: "employee_count",
    label: "Employees",
    valueKind: "number",
    scope: "both",
  },
  {
    kind: "range",
    field: "founded_year",
    label: "Founded year",
    valueKind: "number",
    scope: "both",
  },
];

const ACCOUNT_QUICK_GROUP: AccountFilterGroup = {
  id: "quick",
  title: "Quick filters",
  facets: ACCOUNT_QUICK_FACETS,
  scope: "both",
};

// ── Tier 2: "All filters" — workspace-only firmographics, grouped ───────────────────────────────────────
export const ACCOUNT_ALL_FILTER_GROUPS: AccountFilterGroup[] = [
  {
    id: "industry",
    title: "Industry details",
    scope: "workspace-only",
    facets: [
      {
        kind: "term",
        field: "sub_industry",
        label: "Sub-industry",
        input: "typeahead",
        scope: "workspace-only",
      },
    ],
  },
  {
    id: "size",
    title: "Revenue",
    scope: "workspace-only",
    facets: [
      {
        // This control was labelled "Revenue" but bound to `company_stage`, so picking "Enterprise" filtered
        // by company stage under a Revenue heading — while `company_stage` ALSO appeared, correctly labelled,
        // in "Funding & stage" below. Two controls wrote the same clause, the chip for either was labelled
        // "Revenue" (facetLabel returns the first match), and the real revenue_range facet — supported by the
        // server, and whose counts this pane was already requesting — had nothing to render them.
        kind: "term",
        field: "revenue_range",
        label: "Revenue",
        input: "counts",
        scope: "workspace-only",
      },
    ],
  },
  {
    id: "technographics",
    title: "Technographics",
    scope: "workspace-only",
    facets: [
      {
        kind: "term",
        field: "technology",
        label: "Technology",
        input: "typeahead",
        scope: "workspace-only",
      },
    ],
  },
  {
    id: "funding",
    title: "Funding & stage",
    scope: "workspace-only",
    facets: [
      {
        kind: "term",
        field: "funding_stage",
        label: "Funding stage",
        input: "options",
        options: optionsOf(FUNDING_STAGES),
        scope: "workspace-only",
      },
      {
        kind: "term",
        field: "company_stage",
        label: "Company stage",
        input: "options",
        options: optionsOf(COMPANY_STAGES),
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
    id: "fit",
    title: "Fit",
    scope: "workspace-only",
    facets: [
      // Supported by accountSearchRepository's range dispatch since ICP scoring landed, but never offered
      // in the sidebar — "show me only my best-fit accounts" was a question the panel could not ask.
      {
        kind: "range",
        field: "icp_fit_score",
        label: "ICP fit score",
        valueKind: "number",
        scope: "workspace-only",
      },
    ],
  },
];

/** Every group, quick tier first — the flat registry the lookups, chips and scope tests read. */
export const ACCOUNT_FILTER_GROUPS: AccountFilterGroup[] = [
  ACCOUNT_QUICK_GROUP,
  ...ACCOUNT_ALL_FILTER_GROUPS,
];

/** Every account facet, flattened — the lookups below and the narrowing map both read this. */
const ALL_ACCOUNT_FACETS: AccountFacetDef[] = ACCOUNT_FILTER_GROUPS.flatMap((g) => g.facets);

/**
 * Fields the global graph CAN answer that have no sidebar control of their own. A saved search, a shared URL
 * or the AI parser can still produce them, and they must keep crossing: `employee_band` is the derived size
 * band the global company search filters on directly (the sidebar offers the raw employee_count range).
 */
const EXTRA_SHARED_ACCOUNT_FIELDS = new Set(["employee_band"]);

/** Which engines can answer this field. Unknown ⇒ workspace-only, the safe answer. */
export function accountFacetScope(field: string): AccountFacetScope {
  const declared = ALL_ACCOUNT_FACETS.find((f) => f.field === field);
  if (declared) return declared.scope;
  return EXTRA_SHARED_ACCOUNT_FIELDS.has(field) ? "both" : "workspace-only";
}

/**
 * The fields on the ACTIVE query that the global company graph cannot answer, in sidebar order.
 * FAILS CLOSED on an undeclared field — see the twin in filterGroups.ts for why that matters.
 */
export function accountWorkspaceOnlyFields(query: AccountQuery): string[] {
  const seen = new Set<string>();
  for (const clause of query.filters) {
    if (accountFacetScope(clause.field) === "workspace-only") seen.add(clause.field);
  }
  const declared = ALL_ACCOUNT_FACETS.filter((f) => seen.has(f.field)).map((f) => f.field);
  const known = new Set(declared);
  return [...declared, ...[...seen].filter((f) => !known.has(f))];
}

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

/** Count of active conditions/filters whose field belongs to a group (drives the collapsed-header badge). */
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
        remove: (q) => ({ ...q, filters: q.filters.filter((f) => f !== c) }),
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
