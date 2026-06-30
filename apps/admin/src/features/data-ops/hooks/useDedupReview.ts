// useDedupReview.ts — loads the dedup clerical-review queue (GET /admin/data/dedup/links): recent ER match-links
// across tenants, with loading/error state + reload (the admin app's useState convention — NO TanStack). The typed
// fetch lives in api.ts; the shape is the local MatchLinkRow.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchDedupLinks } from "../api";
import type { MatchLinkRow } from "../types";

export function useDedupReview() {
  const [links, setLinks] = useState<MatchLinkRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setLinks(await fetchDedupLinks());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the dedup review queue");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { links, error, loading, reload };
}
