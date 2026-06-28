// useDataHealthMetrics.ts — loads the per-workspace Data Health rollup (GET /home/data-quality) with loading/error
// + a reload. Presentation state only; the shape comes from @leadwolf/types. Mirrors features/home's useDataQuality
// (the useState + useEffect + useCallback pattern) — apps/web has no TanStack Query, so we keep the manual pattern.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchDataQuality } from "../api";
import type { WorkspaceDataQuality } from "../types";

export function useDataHealthMetrics() {
  const [metrics, setMetrics] = useState<WorkspaceDataQuality | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMetrics(await fetchDataQuality());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load your data health");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { metrics, error, loading, reload };
}
