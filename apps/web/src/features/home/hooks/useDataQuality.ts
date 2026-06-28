// useDataQuality.ts — loads the per-workspace Data Health rollup (GET /home/data-quality) with loading/error +
// a reload. Presentation state only; the shape comes from @leadwolf/types. A lighter sibling of useHomeSummary
// (no module cache — the payload is small + server-cached); the Data Health card fetches it independently of the
// shared summary because it is a separate endpoint.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchDataQuality } from "../api";
import type { WorkspaceDataQuality } from "../types";

export function useDataQuality() {
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
