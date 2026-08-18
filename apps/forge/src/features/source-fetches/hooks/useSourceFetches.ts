// useSourceFetches.ts — loads the fetch-registry telemetry (GET /bff/source-fetches) with loading/error
// state and a `reload`. Presentation state only; the typed fetch lives in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchSourceFetches } from "../api";
import type { SourceFetch } from "../types";

export function useSourceFetches() {
  const [fetches, setFetches] = useState<SourceFetch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setFetches(await fetchSourceFetches());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load source fetches");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { fetches, error, loading, reload };
}
