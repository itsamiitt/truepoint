// useCompliance.ts — loads the DSAR oversight queue (GET /admin/compliance/dsars) with a status filter,
// loading/error state, and a `setStatus`. Presentation state only; the typed fetch lives in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchDsars } from "../api";
import type { DsarRequest } from "../types";

export function useCompliance() {
  const [dsars, setDsars] = useState<DsarRequest[] | null>(null);
  const [status, setStatusState] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Post-mutation reloads report here — re-raising `loading` would blank the populated table back to the
  // StateSwitch skeleton (perf-audit P3.6). A status-filter change still raises `loading`.
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (s: string, opts?: { refresh?: boolean }) => {
    if (opts?.refresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      setDsars(await fetchDsars(s || undefined));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load DSAR requests");
    } finally {
      if (opts?.refresh) setRefreshing(false);
      else setLoading(false);
    }
  }, []);

  const setStatus = useCallback(
    (s: string) => {
      setStatusState(s);
      void load(s);
    },
    [load],
  );

  useEffect(() => {
    void load("");
  }, [load]);

  return {
    dsars,
    status,
    loading,
    refreshing,
    error,
    setStatus,
    reload: useCallback(() => load(status, { refresh: true }), [load, status]),
  };
}
