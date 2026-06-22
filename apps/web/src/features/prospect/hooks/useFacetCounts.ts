// useFacetCounts.ts — live per-option facet counts for the current query (24 §5; POST /search/facets). Returns
// a Map keyed `${field}:${value}` that FilterPanel reads to show "Engineering (142)". Best-effort: a failed
// fetch keeps the last good map (the sidebar simply omits counts) and never breaks the page. Re-fetches when
// the serialized query or field set changes.
"use client";

import type { ContactQuery, FacetKey } from "@leadwolf/types";
import { useEffect, useMemo, useState } from "react";
import { fetchFacetCounts } from "../searchApi";

export function useFacetCounts(query: ContactQuery, fields: FacetKey[]): Map<string, number> {
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const key = useMemo(() => JSON.stringify({ q: query, f: fields }), [query, fields]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-fetch is keyed on the serialized query + fields.
  useEffect(() => {
    if (fields.length === 0) return;
    let alive = true;
    void (async () => {
      try {
        const facets = await fetchFacetCounts(query, fields);
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
