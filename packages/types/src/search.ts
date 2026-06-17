// search.ts — Zod schemas + inferred types for the advanced search / filter / exploration surface
// (24-advanced-search-exploration-ux.md, ADR-0035). Single source of truth for the SearchPort contract
// additions (suggest + facet counts) and the query-semantics layer (title canonicalization + synonym
// expansion). Validation lives here; logic lives in @leadwolf/core/search. Leaf package — no app imports.

import { z } from "zod";

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
