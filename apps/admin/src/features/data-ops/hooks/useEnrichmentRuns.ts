// useEnrichmentRuns.ts — loads the cross-tenant enrichment-run monitor (GET /admin/data/enrichment/runs) with
// loading/error state and a `reload` (the admin app's useState convention — NO TanStack). Presentation state
// only; the typed fetch lives in api.ts and the shape comes from the slice's types.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchEnrichmentRuns } from "../api";
import type { EnrichmentRunRow } from "../types";

export function useEnrichmentRuns() {
  const [runs, setRuns] = useState<EnrichmentRunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRuns(await fetchEnrichmentRuns());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load enrichment runs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { runs, error, loading, reload };
}
