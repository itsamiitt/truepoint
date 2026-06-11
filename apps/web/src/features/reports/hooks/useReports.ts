// useReports.ts — loads the report's raw inputs (balance + usage + contacts, in parallel) and derives the
// three section view models via the pure rollups. Presentation state only; one loading/error pair + reload.
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { type ReportsSource, fetchReportsSource } from "../api";
import { rollupCreditUsage, rollupDataHealth, rollupFunnel } from "../rollups";

export function useReports() {
  const [source, setSource] = useState<ReportsSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSource(await fetchReportsSource());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load reports");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const credit = useMemo(() => (source ? rollupCreditUsage(source.reveals) : null), [source]);
  const funnel = useMemo(() => (source ? rollupFunnel(source.contacts) : null), [source]);
  const health = useMemo(() => (source ? rollupDataHealth(source.contacts) : null), [source]);

  return { balance: source?.balance ?? null, credit, funnel, health, error, loading, reload };
}
