// useDataSourceOrigins.ts — loads the origin fleet with loading/error/reload + the explicit `unavailable`
// degrade (the useProviderConfigs shape verbatim; admin has no react-query by design).
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchDataSourceOrigins } from "../api";
import type { DataSourceOriginView } from "../types";

export function useDataSourceOrigins() {
  const [origins, setOrigins] = useState<DataSourceOriginView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  // Refreshes (post-mutation reloads) report here — re-raising `loading` would blank the populated table
  // back to the StateSwitch skeleton (perf-audit P3.6).
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (opts?: { initial?: boolean }) => {
    if (opts?.initial) setLoading(true);
    else setRefreshing(true);
    setError(null);
    setUnavailable(false);
    try {
      setOrigins(await fetchDataSourceOrigins());
    } catch (e) {
      if (e instanceof Error && e.message === "DATA_SOURCES_ENDPOINT_UNAVAILABLE") {
        setUnavailable(true);
      } else {
        setError(e instanceof Error ? e.message : "Failed to load data sources");
      }
    } finally {
      if (opts?.initial) setLoading(false);
      else setRefreshing(false);
    }
  }, []);

  const reload = useCallback(() => load(), [load]);

  useEffect(() => {
    void load({ initial: true });
  }, [load]);

  return { origins, error, unavailable, loading, refreshing, reload };
}
