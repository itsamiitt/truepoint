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

  const reload = useCallback(async () => {
    setLoading(true);
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
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { providers, error, unavailable, loading, reload };
}
