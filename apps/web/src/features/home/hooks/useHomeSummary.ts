// useHomeSummary.ts — loads the composed cockpit summary (credit balance + recent reveals) with
// loading/error state and a `reload`. Presentation state only; the composition happens in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchHomeSummary } from "../api";
import type { HomeSummary } from "../types";

export function useHomeSummary() {
  const [summary, setSummary] = useState<HomeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSummary(await fetchHomeSummary());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load your workspace summary");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { summary, error, loading, reload };
}
