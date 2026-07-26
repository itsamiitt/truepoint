// useFacetCounts.ts — live per-option facet counts for the current query (24 §5; POST /search/facets). Returns
// a Map keyed `${field}:${value}` that FilterPanel reads to show "Engineering (142)". Best-effort: a failed
// fetch keeps the last good map (the sidebar simply omits counts) and never breaks the page. Re-fetches when
// the serialized query or field set changes.
"use client";

import type { ContactQuery, FacetKey } from "@leadwolf/types";
import { useEffect, useMemo, useState } from "react";
import { fetchFacetCounts } from "../searchApi";

/** `enabled: false` skips the request entirely — used to stop the Prospect page's INACTIVE scope from fetching
 *  counts for a sidebar nobody is looking at. Aborting on cleanup also frees the connection when the query
 *  changes faster than the server answers, instead of merely ignoring the reply. */
export function useFacetCounts(
  query: ContactQuery,
  fields: FacetKey[],
  options?: { enabled?: boolean },
): Map<string, number> {
  const enabled = options?.enabled ?? true;
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const key = useMemo(() => JSON.stringify({ q: query, f: fields }), [query, fields]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-fetch is keyed on the serialized query + fields.
  useEffect(() => {
    if (!enabled || fields.length === 0) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const facets = await fetchFacetCounts(query, fields, controller.signal);
        if (controller.signal.aborted) return;
        const next = new Map<string, number>();
        for (const f of facets) next.set(`${f.field}:${f.value}`, f.count);
        setCounts(next);
      } catch {
        // counts are best-effort; keep the last good map. An abort lands here too and is equally harmless.
      }
    })();
    return () => controller.abort();
  }, [key, enabled]);

  return counts;
}
