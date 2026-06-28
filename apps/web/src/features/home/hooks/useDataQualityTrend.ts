// useDataQualityTrend.ts — loads the per-workspace Data Health trend series (GET /home/data-quality/history) with
// loading/error + a reload. Presentation state only; the shape comes from @leadwolf/types. A lighter sibling of
// useHomeSummary (no module cache); the Freshness-trend card fetches it independently of the shared summary.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchDataQualityHistory } from "../api";
import type { DataQualityTrendPoint } from "../types";

export function useDataQualityTrend() {
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
