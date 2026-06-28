// useRetentionRuns.ts — loads the cross-tenant retention-RUNS review (GET /admin/retention-runs) with
// loading/error/reload state (the admin app's useState convention — NO TanStack). Presentation state only; the
// typed fetch lives in api.ts and the shape comes from the slice's types. Mirrors useRetentionPolicies.
"use client";

import { useCallback, useEffect, useState } from "react";
import { listRetentionRuns } from "../api";
import type { RetentionRunRow } from "../types";

export function useRetentionRuns() {
  const [runs, setRuns] = useState<RetentionRunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRuns(await listRetentionRuns());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load retention runs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { runs, error, loading, reload };
}
