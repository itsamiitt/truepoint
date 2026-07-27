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
  /** The viewer's saved searches. */
  savedSearches: () => ["prospect", "saved-searches"] as const,
  /** Facet counts for one account search + field set. */
  accountFacets: (query: AccountQuery, fields: AccountFacetKey[]) =>
    ["prospect", "account-facets", query, fields] as const,
};
