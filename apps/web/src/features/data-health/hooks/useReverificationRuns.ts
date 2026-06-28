// useReverificationRuns.ts — loads the per-workspace freshness re-verification runs (GET /home/data-quality/
// reverification-runs) with loading/error + a reload. Presentation state only; the shape comes from @leadwolf/types.
// Mirrors features/home's useDataQuality pattern (useState + useEffect + useCallback); no TanStack Query in apps/web.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchReverificationRuns } from "../api";
import type { ReverificationRun } from "../types";

export function useReverificationRuns() {
  const [runs, setRuns] = useState<ReverificationRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRuns(await fetchReverificationRuns());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load your re-verification activity");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { runs, error, loading, reload };
}
