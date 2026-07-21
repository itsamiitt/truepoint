// useSyncStatus.ts — loads the downstream sync destinations (GET /bff/sync-status) with loading/error state and
// a `reload`. Presentation state only; the typed fetch lives in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchSyncStatus } from "../api";
import type { SyncTarget } from "../types";

export function useSyncStatus() {
  const [targets, setTargets] = useState<SyncTarget[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTargets(await fetchSyncStatus());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load sync status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { targets, error, loading, reload };
}
