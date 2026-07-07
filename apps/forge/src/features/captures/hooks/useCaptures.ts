// useCaptures.ts — loads the captured-items feed (GET /bff/captures) with loading/error state and a `reload`.
// Presentation state only; the typed fetch lives in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchCaptures } from "../api";
import type { Capture } from "../types";

export function useCaptures() {
  const [captures, setCaptures] = useState<Capture[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCaptures(await fetchCaptures());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load captures");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { captures, error, loading, reload };
}
