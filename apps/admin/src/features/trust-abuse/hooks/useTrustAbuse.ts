// useTrustAbuse.ts — loads the trust/abuse signals (GET /admin/trust-abuse) with loading/error state and a
// `reload`. Presentation state only; the typed fetch lives in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchTrustAbuse } from "../api";
import type { TrustAbuse } from "../types";

export function useTrustAbuse() {
  const [data, setData] = useState<TrustAbuse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchTrustAbuse());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load trust signals");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload };
}
