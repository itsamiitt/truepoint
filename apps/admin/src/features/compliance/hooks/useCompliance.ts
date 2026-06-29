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

  const load = useCallback(async (s: string) => {
    setLoading(true);
    setError(null);
    try {
      setDsars(await fetchDsars(s || undefined));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load DSAR requests");
    } finally {
      setLoading(false);
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
    error,
    setStatus,
    reload: useCallback(() => load(status), [load, status]),
  };
}
