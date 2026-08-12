// keys.ts — the prospect feature's TanStack Query key factory. Single source so every hook and mutation
// reads/invalidates the SAME keys and the cache never fragments.
//
// The two search entries hold the QUERY OBJECT itself, not a serialization of it: RQ hashes keys structurally
// (stable across key order), so a distinct search is a distinct cache entry for free. That is what makes the
// keyset pages of one search accumulate under one entry while a filter edit starts a clean one — and what
// makes a superseded search unable to overwrite the current one, which the hand-rolled AbortController dance
// these hooks used to run existed to approximate.
import type { AccountFacetKey, AccountQuery, ContactQuery, FacetKey } from "@leadwolf/types";

export const prospectKeys = {
  all: ["prospect"] as const,
  /** One contact search (all its keyset pages live under this single infinite-query entry). */
  contactSearch: (query: ContactQuery) => ["prospect", "contact-search", query] as const,
  /** One account search (same shape, separate namespace — the two grids coexist in one URL). */
  accountSearch: (query: AccountQuery) => ["prospect", "account-search", query] as const,
  /** Facet counts for one contact search + field set (they change together, so they key together). */
  contactFacets: (query: ContactQuery, fields: FacetKey[]) =>
    ["prospect", "contact-facets", query, fields] as const,
  /** The workspace's tags (`GET /tags`). */
  tags: () => ["prospect", "tags"] as const,
  /** The record ids carrying one tag (`GET /tags/:id/records`). */
  taggedRecords: (tagId: string) => ["prospect", "tagged-records", tagId] as const,
  /** The workspace's pipeline stages; archived rows are a different result, so they key separately. */
  stages: (includeArchived: boolean) => ["prospect", "stages", includeArchived] as const,
  /** One contact's custom-field feed. */
  customFields: (contactId: string) => ["prospect", "custom-fields", contactId] as const,
  /** One contact's activity timeline. */
  activities: (contactId: string) => ["prospect", "activities", contactId] as const,
  /** One contact's already-owned reveal data (no charge — the read, not the reveal). */
  revealedContact: (contactId: string) => ["prospect", "revealed-contact", contactId] as const,
  /** One contact's lead-score history. */
  scores: (contactId: string) => ["prospect", "scores", contactId] as const,
  /** One account's Layer-0 technology traversal. `relationship` is part of the key because develops and uses
   *  are DIFFERENT ANSWERS from different tables — sharing one cache entry would let one overwrite the other. */
  accountTechnologies: (accountId: string, relationship: "develops" | "uses") =>
    ["prospect", "account-technologies", accountId, relationship] as const,
  /** One contact's Layer-0 education edges (`GET /contacts/:id/education`). */
  contactEducation: (contactId: string) => ["prospect", "contact-education", contactId] as const,
  /** One contact's Layer-0 employment stints (`GET /contacts/:id/employment`). */
  contactEmployment: (contactId: string) => ["prospect", "contact-employment", contactId] as const,
  /** One contact's field provenance / confidence badges (`GET /contacts/:id/provenance`). */
  contactProvenance: (contactId: string) => ["prospect", "contact-provenance", contactId] as const,
  /** Typeahead suggestions for one facet + term — the cache entry IS the per-term memo. */
  typeahead: (field: string, term: string) => ["prospect", "typeahead", field, term] as const,
  /** One async bulk-reveal job's status/progress. */
  revealJob: (jobId: string) => ["prospect", "reveal-job", jobId] as const,
  /** The viewer's saved searches. */
  savedSearches: () => ["prospect", "saved-searches"] as const,
  /** Facet counts for one account search + field set. */
  accountFacets: (query: AccountQuery, fields: AccountFacetKey[]) =>
    ["prospect", "account-facets", query, fields] as const,
};
