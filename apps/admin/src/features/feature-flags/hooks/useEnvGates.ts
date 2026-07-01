// useEnvGates.ts — loads the deploy-time env master-switch states (GET /admin/feature-flags/env-gates) with
// loading/error/reload. Read-only (these are process kill-switches, not UI-toggleable). Mirrors useFeatureFlags.
"use client";

import type { EnvFeatureGate } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import { fetchEnvGates } from "../api";

export function useEnvGates() {
  const [gates, setGates] = useState<EnvFeatureGate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setGates(await fetchEnvGates());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load master switches");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { gates, error, loading, reload };
}
