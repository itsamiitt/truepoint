// useRetentionRuns.ts — loads the per-tenant retention-engine run audit (GET /home/data-quality/retention-runs)
// with loading/error + a reload. Presentation state only; the shape comes from @leadwolf/types. Mirrors
// useReverificationRuns (useState + useEffect + useCallback); no TanStack Query in apps/web.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchRetentionRuns } from "../api";
import type { RetentionRun } from "../types";

export function useRetentionRuns() {
  const [runs, setRuns] = useState<RetentionRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRuns(await fetchRetentionRuns());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load your retention activity");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { runs, error, loading, reload };
}
