// useVerificationRuns.ts — loads the cross-tenant freshness re-verification monitor
// (GET /admin/data/verification/runs) with loading/error state and a `reload` (the admin app's useState
// convention — NO TanStack). Presentation state only; the typed fetch lives in api.ts and the shape comes from
// the slice's types.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchVerificationRuns } from "../api";
import type { VerificationRunRow } from "../types";

export function useVerificationRuns() {
  const [runs, setRuns] = useState<VerificationRunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRuns(await fetchVerificationRuns());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load verification runs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { runs, error, loading, reload };
}
