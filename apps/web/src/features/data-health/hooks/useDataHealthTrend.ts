// useDataHealthTrend.ts — loads the per-workspace Data Health trend series (GET /home/data-quality/history) with
// loading/error + a reload. Presentation state only; the shape comes from @leadwolf/types. Mirrors features/home's
// useDataQualityTrend (the useState + useEffect + useCallback pattern); no TanStack Query in apps/web.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchDataQualityHistory } from "../api";
import type { DataQualityTrendPoint } from "../types";

export function useDataHealthTrend() {
  const [trend, setTrend] = useState<DataQualityTrendPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTrend(await fetchDataQualityHistory());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load your data health history");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { trend, error, loading, reload };
}
