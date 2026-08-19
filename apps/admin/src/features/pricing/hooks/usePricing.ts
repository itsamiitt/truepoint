// usePricing.ts — loads the credit-pack catalog (GET /admin/pricing/credit-packs) with loading/error state
// and a `reload`. Presentation state only; the typed fetches + mutations live in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchCreditPacks } from "../api";
import type { CreditPack } from "../types";

export function usePricing() {
  const [packs, setPacks] = useState<CreditPack[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Refreshes (post-mutation reloads) report here — re-raising `loading` would blank the populated table
  // back to the StateSwitch skeleton (perf-audit P3.6).
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (opts?: { initial?: boolean }) => {
    if (opts?.initial) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      setPacks(await fetchCreditPacks());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load credit packs");
    } finally {
      if (opts?.initial) setLoading(false);
      else setRefreshing(false);
    }
  }, []);

  const reload = useCallback(() => load(), [load]);

  useEffect(() => {
    void load({ initial: true });
  }, [load]);

  return { packs, error, loading, refreshing, reload };
}
