// useValidationRules.ts — loads the global data-quality rule set (GET /admin/data/validation/rules): the built-in
// checks + the custom rules, with loading/error state + a `reload` (the admin app's useState convention — NO
// TanStack). Presentation state only; the typed fetch lives in api.ts, the shape is @leadwolf/types ValidationRule.
"use client";

import type { ValidationRule } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import { fetchValidationRules } from "../api";

export function useValidationRules() {
  const [rules, setRules] = useState<ValidationRule[] | null>(null);
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
      setRules(await fetchValidationRules());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load validation rules");
    } finally {
      if (opts?.initial) setLoading(false);
      else setRefreshing(false);
    }
  }, []);

  const reload = useCallback(() => load(), [load]);

  useEffect(() => {
    void load({ initial: true });
  }, [load]);

  return { rules, error, loading, refreshing, reload };
}
