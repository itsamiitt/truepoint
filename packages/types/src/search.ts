// search.ts — Zod schemas + inferred types for the advanced search / filter / exploration surface
// (24-advanced-search-exploration-ux.md, ADR-0035). Single source of truth for the SearchPort contract
// additions (suggest + facet counts) and the query-semantics layer (title canonicalization + synonym
// expansion). Validation lives here; logic lives in @leadwolf/core/search. Leaf package — no app imports.

import { z } from "zod";
import type { MaskedContact } from "./contacts.ts";

// ── Facets ───────────────────────────────────────────────────────────────────────────────────────────
/**
 * The fields exposed as search-box-first facets with typeahead suggestions (24 §3.1). High-cardinality
 * fields are suggested from indexed values; `title` additionally flows through the canonical taxonomy so
 * "CEO" collapses to one occupation (24 §4).
 */
export const facetKey = z.enum([
  "title",
  "company",
  "industry",
  "technology",
  "location",
  "skill",
  "seniority",
  "department",
  // Engagement + firmographic + source facets (soft-owner search). `owner` powers "My prospects"/by-owner;
  // the rest filter on contact/account columns. The dev adapter projects the masked-view-backed ones
  // (owner/outreach_status/email_status); source/funding_stage/company_stage need the account/import joins
  // the Postgres adapter does (the dev adapter returns no values for them).
  "owner",
  "outreach_status",
  "email_status",
  "source",
  "funding_stage",
  "company_stage",
]);
export type FacetKey = z.infer<typeof facetKey>;

/** Coarse job function derived from a canonical title — used for grouping + as a derived facet (24 §4.1). */
export const titleFunction = z.enum([
  "executive",
  "engineering",
  "product",
  "design",
  "data",
  "it",
  "sales",
  "marketing",
  "finance",
  "hr",
  "operations",
  "legal",
  "customer_success",
  "other",
]);
export type TitleFunction = z.infer<typeof titleFunction>;

// ── Typeahead / autocomplete (SearchPort.suggest) ──────────────────────────────────────────────────────
/** A typeahead request: a debounced, min-length prefix scoped to one facet (24 §3.3). */
export const suggestQuery = z.object({
  field: facetKey,
  prefix: z.string().trim().min(1).max(120),
  limit: z.number().int().min(1).max(50).default(10),
  scope: z.enum(["global", "workspace"]).default("workspace"),
});
export type SuggestQuery = z.infer<typeof suggestQuery>;

/** One suggestion drawn from the index, with its match count and (for titles) its canonical id (24 §3.2). */
export const suggestion = z.object({
  value: z.string(),
  displayLabel: z.string(),
  count: z.number().int().min(0),
  canonicalId: z.string().optional(),
});
export type Suggestion = z.infer<typeof suggestion>;

/** One facet value + its result count, returned alongside results so refinement shows live counts (24 §5). */
export const facetCount = z.object({
  field: facetKey,
  value: z.string(),
  displayLabel: z.string(),
  count: z.number().int().min(0),
});
export type FacetCount = z.infer<typeof facetCount>;

// ── Query semantics (24 §4 / ADR-0035) ─────────────────────────────────────────────────────────────────
/**
 * The result of expanding a typed term through the synonym/abbreviation layer. `canonicalId` is set when
 * the term resolved to a canonical title; `synonyms` is the set of surface forms the search engine should
 * match (the app-side equivalent of an Elasticsearch `synonym_graph`, ADR-0035). Example: "CEO" →
 * { canonicalId: "chief_executive_officer", synonyms: ["ceo", "chief executive officer", ...] }.
 */
export const expandedTerm = z.object({
  input: z.string(),
  normalized: z.string(),
  canonicalId: z.string().nullable(),
  canonicalLabel: z.string().nullable(),
  synonyms: z.array(z.string()),
});
export type ExpandedTerm = z.infer<typeof expandedTerm>;

// ── Query contract (SearchPort input) ──────────────────────────────────────────────────────────────────
/** A term facet clause: include or exclude a set of values for one facet (24 §2 multi-select is/is-not). */
export const termFilter = z.object({
  kind: z.literal("term"),
  field: facetKey,
  op: z.enum(["include", "exclude"]).default("include"),
  values: z.array(z.string().min(1)).min(1),
});
export type TermFilter = z.infer<typeof termFilter>;

/** A numeric range clause (headcount, revenue, score, signal recency — 24 §2). At least one bound required. */
export const rangeFilter = z
  .object({
    kind: z.literal("range"),
    field: z.string().min(1),
    gte: z.number().optional(),
    lte: z.number().optional(),
  })
  .refine((r) => r.gte !== undefined || r.lte !== undefined, "range needs gte or lte");
export type RangeFilter = z.infer<typeof rangeFilter>;

/**
 * A boolean data-signal clause (24 §2 "Data signals"): does the contact have an email / phone / LinkedIn,
 * is it revealed, never-contacted, do-not-contact (suppressed), a likely duplicate, or a complete record.
 * `value` selects the side (true = has it / is it). The dev adapter supports the masked-view-backed ones
 * (has_email/has_phone/is_revealed); the rest need joins the Postgres adapter does.
 */
export const boolFilterField = z.enum([
  "has_email",
  "has_phone",
  "has_linkedin",
  "is_revealed",
  "never_contacted",
  "do_not_contact",
  "duplicate",
  "complete",
]);
export type BoolFilterField = z.infer<typeof boolFilterField>;

export const boolFilter = z.object({
  kind: z.literal("bool"),
  field: boolFilterField,
  value: z.boolean(),
});
export type BoolFilter = z.infer<typeof boolFilter>;

// Note: z.union (not discriminatedUnion) because rangeFilter carries a .refine() (a ZodEffects), which
// discriminatedUnion rejects. The literal `kind` still makes each branch unambiguous to consumers.
export const filterClause = z.union([termFilter, rangeFilter, boolFilter]);
export type FilterClause = z.infer<typeof filterClause>;

/** A validated search request. `cursor` drives keyset pagination (24 §6); never offset. */
export const contactQuery = z.object({
  text: z.string().trim().max(200).optional(),
  filters: z.array(filterClause).default([]),
  sort: z.enum(["relevance", "score_desc", "created_desc"]).default("relevance"),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type ContactQuery = z.infer<typeof contactQuery>;

/** A facet-count request: the active query + which facets to count (POST body for /search/facets). */
export const facetCountsRequest = z.object({
  query: contactQuery,
  fields: z.array(facetKey).min(1),
});
export type FacetCountsRequest = z.infer<typeof facetCountsRequest>;

// ── Port contract (24 §3.3, ADR-0002 amended by ADR-0035) ──────────────────────────────────────────────
/** Tenant scope every SearchPort call is filtered by — never cross-workspace (ADR-0006). */
export interface SearchCtx {
  workspaceId: string;
  /** The verified caller (the route sets it from claims.sub). Powers the owner ("My prospects") filter and
   *  recent-search attribution. Optional so existing callers/tests compile; the API always provides it. */
  userId?: string;
}

/** A single result row: the masked contact view + its resolved canonical title id (24 §4.2). */
export type ContactHit = MaskedContact & { canonicalTitleId?: string };

/** One keyset page of results, with the cursor for the next page and optional live facet counts (24 §5). */
export interface SearchPage<T> {
  hits: T[];
  nextCursor: string | null;
  facets?: FacetCount[];
}

/**
 * The single seam all search goes through (ADR-0002). Callers never embed engine-specific queries; adapters
 * (OpenSearch global / Typesense overlay / Postgres dev) live in `packages/search`. `suggest` + `facetCounts`
 * are the ADR-0035 additions powering search-box typeahead and live facet counts.
 */
export interface SearchPort {
  searchContacts(query: ContactQuery, ctx: SearchCtx): Promise<SearchPage<ContactHit>>;
  suggest(req: SuggestQuery, ctx: SearchCtx): Promise<Suggestion[]>;
  facetCounts(query: ContactQuery, fields: FacetKey[], ctx: SearchCtx): Promise<FacetCount[]>;
  index(entity: "contact" | "account", id: string, ctx: SearchCtx): Promise<void>;
}
