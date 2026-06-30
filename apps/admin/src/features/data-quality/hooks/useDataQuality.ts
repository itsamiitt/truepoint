// useDataQuality.ts — loads the data-quality cockpit (GET /admin/data-quality) with loading/error state, a
// `days` window selector, and a `reload`. Presentation state only; the typed fetch lives in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchDataQuality } from "../api";
import type { DataQuality } from "../types";

export function useDataQuality() {
  const [data, setData] = useState<DataQuality | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);

  const load = useCallback(async (d: number) => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchDataQuality(d));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load data quality");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(days);
  }, [load, days]);

  return {
    data,
    error,
    loading,
    days,
    applyDays: useCallback((d: number) => setDays(d), []),
    reload: useCallback(() => load(days), [load, days]),
  };
}
