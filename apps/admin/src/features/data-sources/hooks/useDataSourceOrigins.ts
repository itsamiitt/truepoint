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

  const reload = useCallback(async () => {
    setLoading(true);
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
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { origins, error, unavailable, loading, reload };
}
