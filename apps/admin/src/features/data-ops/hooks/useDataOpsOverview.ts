// useDataOpsOverview.ts — loads the cross-tenant Data-Ops Overview (GET /admin/data/overview) with loading/error
// state and a `reload` (the admin app's useState convention — NO TanStack). Presentation state only; the typed
// fetch lives in api.ts and the shape comes from the slice's types.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchDataOpsOverview } from "../api";
import type { DataOpsOverview } from "../types";

export function useDataOpsOverview() {
  const [overview, setOverview] = useState<DataOpsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOverview(await fetchDataOpsOverview());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the data-ops overview");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { overview, error, loading, reload };
}
