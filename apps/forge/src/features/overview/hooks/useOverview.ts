// useOverview.ts — loads the operator dashboard summary (GET /bff/overview) with loading/error state and a
// `reload`. Presentation state only; the typed fetch lives in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchOverview } from "../api";
import type { OverviewSummary } from "../types";

export function useOverview() {
  const [data, setData] = useState<OverviewSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchOverview());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the overview");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload };
}
