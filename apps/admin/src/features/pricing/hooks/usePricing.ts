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

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPacks(await fetchCreditPacks());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load credit packs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { packs, error, loading, reload };
}
