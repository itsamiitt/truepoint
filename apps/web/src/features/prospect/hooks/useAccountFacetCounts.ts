// useAccountFacetCounts.ts — live per-option facet counts for the current AccountQuery (the company-level
// sibling of useFacetCounts; POST /account-search/facets). Returns a Map keyed `${field}:${value}` that
// AccountFilterPanel reads to show "Software (142)". Best-effort: a failed fetch keeps the last good map (the
// sidebar simply omits counts) and never breaks the page. Re-fetches when the serialized query or field set
// changes.
"use client";

import type { AccountFacetKey, AccountQuery } from "@leadwolf/types";
import { useEffect, useMemo, useState } from "react";
import { fetchAccountFacetCounts } from "../accountSearchApi";

export function useAccountFacetCounts(
  query: AccountQuery,
  fields: AccountFacetKey[],
): Map<string, number> {
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const key = useMemo(() => JSON.stringify({ q: query, f: fields }), [query, fields]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-fetch is keyed on the serialized query + fields.
  useEffect(() => {
    if (fields.length === 0) return;
    let alive = true;
    void (async () => {
      try {
        const facets = await fetchAccountFacetCounts(query, fields);
        if (!alive) return;
        const next = new Map<string, number>();
        for (const f of facets) next.set(`${f.field}:${f.value}`, f.count);
        setCounts(next);
      } catch {
        // counts are best-effort; keep the last good map.
      }
    })();
    return () => {
      alive = false;
    };
  }, [key]);

  return counts;
}
