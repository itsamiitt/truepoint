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

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRules(await fetchValidationRules());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load validation rules");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { rules, error, loading, reload };
}
