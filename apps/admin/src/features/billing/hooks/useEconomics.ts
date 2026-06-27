// useEconomics.ts — loads the credit-economics rollup (GET /admin/billing/economics) for a selectable window,
// with loading/error state and a `setPeriod`. Presentation state only; the typed fetch lives in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchEconomics } from "../api";
import type { EconomicsSummary } from "../types";

export function useEconomics(initialDays = 30) {
  const [summary, setSummary] = useState<EconomicsSummary | null>(null);
  const [sinceDays, setSinceDays] = useState(initialDays);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (days: number) => {
    setLoading(true);
    setError(null);
    try {
      setSummary(await fetchEconomics(days));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load economics");
    } finally {
      setLoading(false);
    }
  }, []);

  const setPeriod = useCallback(
    (days: number) => {
      setSinceDays(days);
      void load(days);
    },
    [load],
  );

  useEffect(() => {
    void load(initialDays);
  }, [load, initialDays]);

  return {
    summary,
    sinceDays,
    loading,
    error,
    setPeriod,
    reload: useCallback(() => load(sinceDays), [load, sinceDays]),
  };
}
