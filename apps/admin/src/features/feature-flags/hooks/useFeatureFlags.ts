// useFeatureFlags.ts — loads the flag list (GET /admin/feature-flags) with loading/error/reload state.
// Presentation state only; typed fetches live in api.ts and the shapes come from @leadwolf/types.
"use client";

import type { FeatureFlagWithOverrides } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import { fetchFeatureFlags } from "../api";

export function useFeatureFlags() {
  const [flags, setFlags] = useState<FeatureFlagWithOverrides[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setFlags(await fetchFeatureFlags());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load feature flags");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { flags, error, loading, reload };
}
