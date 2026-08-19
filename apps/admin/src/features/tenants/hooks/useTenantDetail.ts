// useTenantDetail.ts — loads one org's detail (GET /admin/tenants/:id) with loading/error state and a
// `reload`. Presentation state only; the typed fetch lives in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchTenantDetail } from "../api";
import type { TenantDetail } from "../types";

export function useTenantDetail(id: string) {
  const [detail, setDetail] = useState<TenantDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Refreshes (post-mutation reloads) report here — re-raising `loading` would blank the populated page
  // back to the StateSwitch skeleton (perf-audit P3.6). An `id` change still raises `loading`.
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (opts?: { initial?: boolean }) => {
      if (opts?.initial) setLoading(true);
      else setRefreshing(true);
      setError(null);
      try {
        setDetail(await fetchTenantDetail(id));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load tenant");
      } finally {
        if (opts?.initial) setLoading(false);
        else setRefreshing(false);
      }
    },
    [id],
  );

  const reload = useCallback(() => load(), [load]);

  useEffect(() => {
    void load({ initial: true });
  }, [load]);

  return { detail, error, loading, refreshing, reload };
}
