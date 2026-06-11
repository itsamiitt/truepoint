// useBilling.ts — view state for the billing surface: loads the credit-pool balance + usage history
// together, exposing one loading/error pair and a `reload`. Presentation state only; the metering and
// credit accounting happen server-side (07 §3).
"use client";

import { useCallback, useEffect, useState } from "react";
import { type UsageReveal, fetchBalance, fetchUsage } from "../api";

export function useBilling(limit = 100) {
  const [balance, setBalance] = useState<number | null>(null);
  const [usage, setUsage] = useState<UsageReveal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [b, u] = await Promise.all([fetchBalance(), fetchUsage(limit)]);
      setBalance(b);
      setUsage(u);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load billing");
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { balance, usage, error, loading, reload };
}
