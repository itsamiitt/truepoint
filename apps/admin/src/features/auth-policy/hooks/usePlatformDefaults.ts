// usePlatformDefaults.ts — client loader for the platform-default auth policy (the app's useState/useEffect
// convention; no TanStack). Returns the rows plus loading/error and a reload() the page uses after a mutation.
"use client";

import { useCallback, useEffect, useState } from "react";
import { type PlatformDefault, listPlatformDefaults } from "../api";

export function usePlatformDefaults(): {
  rows: PlatformDefault[];
  error: string | null;
  loading: boolean;
  refreshing: boolean;
  reload: () => Promise<void>;
} {
  const [rows, setRows] = useState<PlatformDefault[]>([]);
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
      setRows(await listPlatformDefaults());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load platform auth defaults");
    } finally {
      if (opts?.initial) setLoading(false);
      else setRefreshing(false);
    }
  }, []);

  const reload = useCallback(() => load(), [load]);

  useEffect(() => {
    void load({ initial: true });
  }, [load]);

  return { rows, error, loading, refreshing, reload };
}
