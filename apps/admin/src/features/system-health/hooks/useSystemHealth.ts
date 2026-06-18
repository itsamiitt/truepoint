// useSystemHealth.ts — loads the system-health summary (GET /admin/system-health) with loading/error state
// and a `reload`. Presentation state only; the typed fetch lives in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchSystemHealth } from "../api";
import type { SystemHealth } from "../types";

export function useSystemHealth() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setHealth(await fetchSystemHealth());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load system health");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { health, error, loading, reload };
}
