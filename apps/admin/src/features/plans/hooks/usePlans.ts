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

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTemplates(await fetchPlanTemplates());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load plan templates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { templates, error, loading, reload };
}
