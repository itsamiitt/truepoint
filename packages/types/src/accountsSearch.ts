// accountsSearch.ts — Zod schemas + inferred types for the COMPANY-level (accounts) search surface, the
// firmographic sibling of the contact search (24-advanced-search-exploration-ux.md, ADR-0035). Same shape
// and idioms as search.ts: reuse the FilterClause union (term/range/bool), keyset cursor, live facet counts.
// Accounts carry NO PII — keep it that way. Validation lives here; logic lives in @leadwolf/db
// (accountSearchRepository) + the apps/api account-search feature. Leaf package — no app imports.

import { z } from "zod";
import { boolFilter, rangeFilter } from "./search.ts";

// ── Facets (company-level) ─────────────────────────────────────────────────────────────────────────────
/**
 * The fields exposed as account search facets with typeahead/live counts (24 §3.1, firmographic side). All
 * are non-PII company columns on `accounts`. `employee_band` is DERIVED from employee_count (coarse headcount
 * bands) rather than a raw column, so the facet stays low-cardinality and useful as a refinement.
 */
export const accountFacetKey = z.enum([
  "industry",
  "sub_industry",
  "technology",
  "funding_stage",
  "company_stage",
  "revenue_range",
  "hq_country",
  "employee_band",
]);
export type AccountFacetKey = z.infer<typeof accountFacetKey>;

// ── Headcount bands (derived from employee_count) ──────────────────────────────────────────────────────
/**
 * Coarse headcount buckets used by the `employee_band` facet + as a friendly alternative to a raw
 * employee_count range. The adapter maps a band id → its [min, max] employee_count bounds (max=null is
 * open-ended). Kept here so the API, the repo, and the web client all agree on the exact bands.
 */
export const employeeBand = z.enum([
  "1-10",
  "11-50",
  "51-200",
  "201-500",
  "501-1000",
  "1001-5000",
  "5001-10000",
  "10001+",
]);
export type EmployeeBand = z.infer<typeof employeeBand>;

/** band id → inclusive employee_count bounds (`max: null` = open-ended). Single source of truth for the band ↔ range mapping. */
export const EMPLOYEE_BANDS: ReadonlyArray<{
  band: EmployeeBand;
  min: number;
  max: number | null;
}> = [
  { band: "1-10", min: 1, max: 10 },
  { band: "11-50", min: 11, max: 50 },
  { band: "51-200", min: 51, max: 200 },
  { band: "201-500", min: 201, max: 500 },
  { band: "501-1000", min: 501, max: 1000 },
  { band: "1001-5000", min: 1001, max: 5000 },
  { band: "5001-10000", min: 5001, max: 10000 },
  { band: "10001+", min: 10001, max: null },
];

// ── Typeahead / autocomplete (account suggest) ─────────────────────────────────────────────────────────
/** The subset of facets that support prefix typeahead (high-cardinality value columns). */
export const accountSuggestField = z.enum([
  "industry",
  "sub_industry",
  "technology",
  "hq_country",
  "hq_city",
  "name",
]);
export type AccountSuggestField = z.infer<typeof accountSuggestField>;

/** A typeahead request: a debounced, min-length prefix scoped to one account field (24 §3.3). */
export const accountSuggestQuery = z.object({
  field: accountSuggestField,
  prefix: z.string().trim().min(1).max(120),
  limit: z.number().int().min(1).max(50).default(10),
});
export type AccountSuggestQuery = z.infer<typeof accountSuggestQuery>;

/** One account-facet value + its result count, returned alongside results so refinement shows live counts. */
export const accountFacetCount = z.object({
  field: accountFacetKey,
  value: z.string(),
  displayLabel: z.string(),
  count: z.number().int().min(0),
});
export type AccountFacetCount = z.infer<typeof accountFacetCount>;

// ── Query contract (account SearchPort input) ──────────────────────────────────────────────────────────
/**
 * The fields an account TERM clause may target (firmographic, non-PII). `hq_city` is filterable + suggestable
 * but is not a low-cardinality live-count facet, so it lives here (term field) but not in accountFacetKey.
 */
export const accountTermField = z.enum([
  "industry",
  "sub_industry",
  "technology",
  "funding_stage",
  "company_stage",
  "revenue_range",
  "hq_country",
  "hq_city",
  "employee_band",
]);
export type AccountTermField = z.infer<typeof accountTermField>;

/**
 * The account term clause — the SAME shape as search.ts termFilter (kind/field/op/values), but keyed on the
 * account term fields (sub_industry/revenue_range/hq_country/hq_city/employee_band aren't in the contact
 * FacetKey). The range + bool clauses are REUSED verbatim from search.ts (rangeFilter/boolFilter), so the
 * FilterClause union is shared in shape across both the contact and the company search surfaces (ADR-0035).
 */
export const accountTermFilter = z.object({
  kind: z.literal("term"),
  field: accountTermField,
  op: z.enum(["include", "exclude"]).default("include"),
  values: z.array(z.string().min(1)).min(1),
});
export type AccountTermFilter = z.infer<typeof accountTermFilter>;

// z.union (not discriminatedUnion) because rangeFilter carries a .refine() (ZodEffects) — same reason as
// search.ts filterClause. The literal `kind` still makes each branch unambiguous to consumers.
export const accountFilterClause = z.union([accountTermFilter, rangeFilter, boolFilter]);
export type AccountFilterClause = z.infer<typeof accountFilterClause>;

/**
 * A validated account-search request (mirrors contactQuery in search.ts). Reuses the FilterClause union shape
 * (term/range/bool, with range+bool literally shared from search.ts) — for accounts:
 *   - term filters target industry / sub_industry / technology (jsonb) / funding_stage / company_stage /
 *     hq_country / hq_city / revenue_range / employee_band (the repo maps each clause.field → its column);
 *   - range filters target employee_count, founded_year (→ company_age), icp_fit_score;
 *   - free text matches name / domain.
 * `cursor` drives keyset pagination (24 §6); never offset. Sorts: relevance (default), name_asc,
 * headcount_desc, created_desc.
 */
export const accountQuery = z.object({
  text: z.string().trim().max(200).optional(),
  filters: z.array(accountFilterClause).default([]),
  sort: z.enum(["relevance", "name_asc", "headcount_desc", "created_desc"]).default("relevance"),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type AccountQuery = z.infer<typeof accountQuery>;

/** A facet-count request: the active query + which account facets to count (POST body for /account-search/facets). */
export const accountFacetCountsRequest = z.object({
  query: accountQuery,
  fields: z.array(accountFacetKey).min(1),
});
export type AccountFacetCountsRequest = z.infer<typeof accountFacetCountsRequest>;

// ── Masked account DTO (what search/list returns — NO PII; accounts are firmographic) ──────────────────
/**
 * A workspace-scoped company row for the accounts result grid. Carries firmographics + the workspace-scoped
 * per-account contact rollup (contactCount + revealedContactCount). No PII fields exist on accounts — this
 * DTO has none and never will. (`MaskedAccount` mirrors MaskedContact's naming for grid symmetry.)
 */
export const maskedAccountSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  domain: z.string().nullable(),
  industry: z.string().nullable(),
  subIndustry: z.string().nullable(),
  employeeCount: z.number().int().nullable(),
  revenueRange: z.string().nullable(),
  hqCountry: z.string().nullable(),
  hqCity: z.string().nullable(),
  technologies: z.array(z.string()),
  fundingStage: z.string().nullable(),
  companyStage: z.string().nullable(),
  foundedYear: z.number().int().nullable(),
  icpFitScore: z.number().int().nullable(),
  // Workspace-scoped per-account contact rollup (same tx, RLS-isolated): total + revealed.
  contactCount: z.number().int().min(0),
  revealedContactCount: z.number().int().min(0),
  createdAt: z.string().datetime({ offset: true }), // ISO-8601 (the account row's creation time).
});
export type MaskedAccount = z.infer<typeof maskedAccountSchema>;

/** One keyset page of account results, with the cursor for the next page (null = last page). */
export interface AccountSearchPage {
  accounts: MaskedAccount[];
  nextCursor: string | null;
}
