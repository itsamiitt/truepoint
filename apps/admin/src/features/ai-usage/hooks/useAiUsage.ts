// useAiUsage.ts — loads the cross-tenant AI-usage rollup (GET /admin/ai-usage) for a selectable window, with
// loading/error state and a `reload`. Presentation state only; the typed fetch lives in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchAiUsage } from "../api";
import type { AiUsageReport } from "../types";

export function useAiUsage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<AiUsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchAiUsage(days));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load AI usage");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, days, setDays, reload };
}
