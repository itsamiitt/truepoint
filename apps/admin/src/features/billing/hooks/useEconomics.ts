// useEconomics.ts — loads the credit-economics rollup (GET /admin/billing/economics) for a selectable window,
// with loading/error state and a `setPeriod`. Presentation state only; the typed fetch lives in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchEconomics,
  fetchEconomicsByTenant,
  fetchEconomicsTrend,
  fetchLowBalance,
} from "../api";
import type {
  EconomicsSummary,
  EconomicsTrendPoint,
  LowBalanceTenant,
  TenantEconomicsRow,
} from "../types";

export function useEconomics(initialDays = 30) {
  const [summary, setSummary] = useState<EconomicsSummary | null>(null);
  const [tenants, setTenants] = useState<TenantEconomicsRow[] | null>(null);
  const [trend, setTrend] = useState<EconomicsTrendPoint[] | null>(null);
  const [lowBalance, setLowBalance] = useState<LowBalanceTenant[] | null>(null);
  const [sinceDays, setSinceDays] = useState(initialDays);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (days: number) => {
    setLoading(true);
    setError(null);
    try {
      // The rollup + trend + drill-down share the window; the low-balance list is current-state (window-
      // independent) but loaded in the same cycle so the page is one fetch.
      const [s, t, tr, lb] = await Promise.all([
        fetchEconomics(days),
        fetchEconomicsByTenant(days),
        fetchEconomicsTrend(days),
        fetchLowBalance(),
      ]);
      setSummary(s);
      setTenants(t);
      setTrend(tr);
      setLowBalance(lb);
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
    tenants,
    trend,
    lowBalance,
    sinceDays,
    loading,
    error,
    setPeriod,
    reload: useCallback(() => load(sinceDays), [load, sinceDays]),
  };
}
