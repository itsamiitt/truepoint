// usePlans.ts — loads the plan-template catalog (GET /admin/pricing/plan-templates) with loading/error state
// and a `reload`. Presentation state only; the typed fetches + mutations live in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchPlanTemplates } from "../api";
import type { PlanTemplate } from "../types";

export function usePlans() {
  const [templates, setTemplates] = useState<PlanTemplate[] | null>(null);
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
      setTemplates(await fetchPlanTemplates());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load plan templates");
    } finally {
      if (opts?.initial) setLoading(false);
      else setRefreshing(false);
    }
  }, []);

  const reload = useCallback(() => load(), [load]);

  useEffect(() => {
    void load({ initial: true });
  }, [load]);

  return { templates, error, loading, refreshing, reload };
}
