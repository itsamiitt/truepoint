// databaseCompanySearch.ts — the contract for the GLOBAL company search (search-consolidation stage 2):
// searching every company the PLATFORM holds, not just the workspace's own `accounts` rows.
//
// It is to `accountsSearch.ts` what `databaseSearch.ts` is to `search.ts`: same shape, different population
// and a different addressing key. A workspace account is a record the workspace OWNS (uuid, contact rollup,
// ICP score); a database company is a company the platform can SELL — addressed by its registrable domain,
// with no Layer-0 identifier of any kind crossing the API boundary.
//
// WHY DOMAIN IS THE KEY. `master_companies.primary_domain` is UNIQUE (uniq_master_companies_primary_domain),
// URL-shaped, and already the key the add-to-workspace materializer upserts accounts by. Using it keeps the
// D4 posture (decisions.md 2026-08-18: URL-shaped identity is the addressing key; numeric ids and urns stay
// internal) that the person surface established with `linkedin_public_id`.
//
// Leaf package — no app imports.
import { z } from "zod";
import { employeeBand } from "./accountsSearch.ts";

/** The fields a company TERM clause may target. All firmographic; companies carry no PII. */
export const databaseCompanyTermField = z.enum([
  "industry",
  "hq_country",
  "hq_city",
  "hq_region",
  "ownership_type",
  "specialty",
  // DERIVED, not a column: `master_companies.employee_band` exists but has no writer and is always NULL, so
  // the repository maps a band id to its employee_count bounds via EMPLOYEE_BANDS — exactly as
  // accountSearchRepository already does for the workspace twin. One band↔range mapping, two surfaces.
  "employee_band",
]);
export type DatabaseCompanyTermField = z.infer<typeof databaseCompanyTermField>;

/** The subset exposed as live-count facets (low cardinality enough to aggregate per query). */
export const databaseCompanyFacetKey = z.enum([
  "industry",
  "hq_country",
  "ownership_type",
  "employee_band",
]);
export type DatabaseCompanyFacetKey = z.infer<typeof databaseCompanyFacetKey>;

export const databaseCompanyTermFilter = z.object({
  kind: z.literal("term"),
  field: databaseCompanyTermField,
  op: z.enum(["include", "exclude"]).default("include"),
  values: z.array(z.string().min(1)).min(1),
});
export type DatabaseCompanyTermFilter = z.infer<typeof databaseCompanyTermFilter>;

/**
 * Numeric ranges. `revenue_minor` targets the STRUCTURED revenue band (revenue_min_minor /
 * revenue_max_minor, minor units) rather than the display varchar — the varchar is a human string and
 * cannot be compared. Currency is deliberately NOT part of the filter: the landed population is
 * single-currency in practice, and silently comparing across currencies would be worse than not offering it.
 */
export const databaseCompanyRangeFilter = z
  .object({
    kind: z.literal("range"),
    field: z.enum(["employee_count", "revenue_minor", "founded_year"]),
    gte: z.number().optional(),
    lte: z.number().optional(),
  })
  .refine((r) => r.gte !== undefined || r.lte !== undefined, "range needs gte or lte");
export type DatabaseCompanyRangeFilter = z.infer<typeof databaseCompanyRangeFilter>;

// z.union (not discriminatedUnion) because the range branch carries a .refine() (a ZodEffects), which
// discriminatedUnion rejects — the same reason search.ts and accountsSearch.ts use a plain union.
export const databaseCompanyFilter = z.union([
  databaseCompanyTermFilter,
  databaseCompanyRangeFilter,
]);
export type DatabaseCompanyFilter = z.infer<typeof databaseCompanyFilter>;

export const databaseCompanyQuery = z.object({
  text: z.string().trim().max(200).optional(),
  filters: z.array(databaseCompanyFilter).default([]),
  sort: z
    .enum(["relevance", "name_asc", "headcount_desc", "recently_updated"])
    .default("relevance"),
  /** Opaque keyset cursor (base64url of {k,d}) — never contains a Layer-0 id. */
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export type DatabaseCompanyQuery = z.infer<typeof databaseCompanyQuery>;

/** One database company as the customer sees it: firmographics + the URL-shaped addressing key. */
export const maskedDatabaseCompanySchema = z.object({
  /** The addressing key. Non-null by construction — MASTER_COMPANY_VISIBLE requires it. */
  primaryDomain: z.string(),
  name: z.string(),
  websiteUrl: z.string().nullable(),
  logoUrl: z.string().nullable(),
  description: z.string().nullable(),
  linkedinCompanyUrl: z.string().nullable(),
  industry: z.string().nullable(),
  /** The canonical taxonomy node (master_industries), when the vendor spelling resolved to an alias. */
  industryCode: z.string().nullable(),
  industryLabel: z.string().nullable(),
  employeeCount: z.number().int().nullable(),
  /** DERIVED from employeeCount — never the dead employee_band column. Null when headcount is unknown. */
  employeeBand: employeeBand.nullable(),
  revenueMinMinor: z.number().nullable(),
  revenueMaxMinor: z.number().nullable(),
  revenueCurrency: z.string().length(3).nullable(),
  revenueDisplay: z.string().nullable(),
  ownershipType: z.string().nullable(),
  yearFounded: z.number().int().nullable(),
  specialties: z.array(z.string()),
  hqCountry: z.string().nullable(),
  hqCity: z.string().nullable(),
  updatedAt: z.string().datetime({ offset: true }),
  /** Set when THIS workspace already holds the company (RLS-scoped probe back to `accounts`). */
  inWorkspace: z
    .object({ accountId: z.string().uuid(), contactCount: z.number().int().min(0) })
    .nullable(),
});
export type MaskedDatabaseCompany = z.infer<typeof maskedDatabaseCompanySchema>;

export const databaseCompanySearchPage = z.object({
  hits: z.array(maskedDatabaseCompanySchema),
  nextCursor: z.string().nullable(),
});
export type DatabaseCompanySearchPage = z.infer<typeof databaseCompanySearchPage>;

/**
 * `capped` true means the server stopped counting at DATABASE_COUNT_CAP and the total is a FLOOR — render
 * it as "10,000+", never as an exact number. Same contract as the workspace contact count.
 */
export const databaseCompanyCountResult = z.object({
  total: z.number().int().nonnegative(),
  capped: z.boolean().default(false),
});
export type DatabaseCompanyCountResult = z.infer<typeof databaseCompanyCountResult>;

/** A facet-count request: the active query + which facets to count (POST body for the facets route). */
export const databaseCompanyFacetsRequest = z.object({
  query: databaseCompanyQuery,
  fields: z.array(databaseCompanyFacetKey).min(1),
});
export type DatabaseCompanyFacetsRequest = z.infer<typeof databaseCompanyFacetsRequest>;

export const databaseCompanyFacetCount = z.object({
  field: databaseCompanyFacetKey,
  value: z.string(),
  count: z.number().int().min(0),
});
export type DatabaseCompanyFacetCount = z.infer<typeof databaseCompanyFacetCount>;
