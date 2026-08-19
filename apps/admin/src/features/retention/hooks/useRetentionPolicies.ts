// useRetentionPolicies.ts — loads the global retention-policy list (GET /admin/retention-policies) with
// loading/error/reload state (the admin app's useState convention — NO TanStack). Presentation state only;
// the typed fetch lives in api.ts and the shapes come from @leadwolf/types.
"use client";

import type { RetentionPolicy } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import { listRetentionPolicies } from "../api";

export function useRetentionPolicies() {
  const [policies, setPolicies] = useState<RetentionPolicy[]>([]);
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
      setPolicies(await listRetentionPolicies());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load retention policies");
    } finally {
      if (opts?.initial) setLoading(false);
      else setRefreshing(false);
    }
  }, []);

  const reload = useCallback(() => load(), [load]);

  useEffect(() => {
    void load({ initial: true });
  }, [load]);

  return { policies, error, loading, refreshing, reload };
}
