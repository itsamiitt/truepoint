// keys.ts — the prospect feature's TanStack Query key factory. Single source so every hook and mutation
// reads/invalidates the SAME keys and the cache never fragments.
//
// The two search entries hold the QUERY OBJECT itself, not a serialization of it: RQ hashes keys structurally
// (stable across key order), so a distinct search is a distinct cache entry for free. That is what makes the
// keyset pages of one search accumulate under one entry while a filter edit starts a clean one — and what
// makes a superseded search unable to overwrite the current one, which the hand-rolled AbortController dance
// these hooks used to run existed to approximate.
import type { AccountQuery, ContactQuery } from "@leadwolf/types";

export const prospectKeys = {
  all: ["prospect"] as const,
  /** One contact search (all its keyset pages live under this single infinite-query entry). */
  contactSearch: (query: ContactQuery) => ["prospect", "contact-search", query] as const,
  /** One account search (same shape, separate namespace — the two grids coexist in one URL). */
  accountSearch: (query: AccountQuery) => ["prospect", "account-search", query] as const,
};
