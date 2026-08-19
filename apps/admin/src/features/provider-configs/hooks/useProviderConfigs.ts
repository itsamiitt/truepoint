// useProviderConfigs.ts — loads the masked provider configs with loading/error/reload + an explicit
// `unavailable` flag for when the provider-config admin endpoint is not yet mounted (graceful degrade).
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchProviderConfigs } from "../api";
import type { ProviderConfigView } from "../types";

export function useProviderConfigs() {
  const [providers, setProviders] = useState<ProviderConfigView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  // Refreshes (post-mutation reloads) report here — re-raising `loading` would blank the populated table
  // back to the StateSwitch skeleton (perf-audit P3.6).
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (opts?: { initial?: boolean }) => {
    if (opts?.initial) setLoading(true);
    else setRefreshing(true);
    setError(null);
    setUnavailable(false);
    try {
      setProviders(await fetchProviderConfigs());
    } catch (e) {
      if (e instanceof Error && e.message === "PROVIDER_CONFIG_ENDPOINT_UNAVAILABLE") {
        setUnavailable(true);
      } else {
        setError(e instanceof Error ? e.message : "Failed to load provider configs");
      }
    } finally {
      if (opts?.initial) setLoading(false);
      else setRefreshing(false);
    }
  }, []);

  const reload = useCallback(() => load(), [load]);

  useEffect(() => {
    void load({ initial: true });
  }, [load]);

  return { providers, error, unavailable, loading, refreshing, reload };
}
