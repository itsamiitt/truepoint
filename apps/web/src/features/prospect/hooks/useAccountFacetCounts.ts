// useAccountFacetCounts.ts — live per-option facet counts for the current AccountQuery (POST /account-search/facets). Returns a Map keyed
// `${field}:${value}` that AccountFilterPanel reads to show "Software (142)". Best-effort: a failed fetch omits counts
// and never breaks the page.
//
// A query rather than a hand-rolled effect + AbortController: RQ owns the signal (so a query that changes
// faster than the server answers frees the connection instead of merely ignoring the reply), and keeps the
// PREVIOUS counts on screen while the next set loads instead of blanking the sidebar on every keystroke.
"use client";

import type { AccountFacetKey, AccountQuery } from "@leadwolf/types";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { fetchAccountFacetCounts } from "../accountSearchApi";
import { prospectKeys } from "../keys";

const EMPTY: ReadonlyMap<string, number> = new Map();

/** `enabled: false` skips the request entirely — used to stop the Prospect page's INACTIVE scope from
 *  fetching counts for a sidebar nobody is looking at. */
export function useAccountFacetCounts(
  query: AccountQuery,
  fields: AccountFacetKey[],
  options?: { enabled?: boolean },
): Map<string, number> {
  const enabled = (options?.enabled ?? true) && fields.length > 0;

  const { data } = useQuery({
    queryKey: prospectKeys.accountFacets(query, fields),
    enabled,
    queryFn: async ({ signal }) => {
      const facets = await fetchAccountFacetCounts(query, fields, signal);
      const next = new Map<string, number>();
      for (const f of facets) next.set(`${f.field}:${f.value}`, f.count);
      return next;
    },
    placeholderData: keepPreviousData,
    // Counts are decoration. Retrying a failed facet call competes with the search itself for connections,
    // and the page is already fully usable without them.
    retry: false,
  });

  // On failure this is the empty map, so the sidebar omits counts. The previous version kept the last good
  // map instead — but those counts belonged to a DIFFERENT query, so showing them against the current one
  // stated a number that was never true for it.
  return (data ?? EMPTY) as Map<string, number>;
}
