// useParsers.ts — loads the registered parsers (GET /bff/parsers) with loading/error state and a `reload`.
// Presentation state only; the typed fetch lives in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchParsers } from "../api";
import type { Parser } from "../types";

export function useParsers() {
  const [parsers, setParsers] = useState<Parser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setParsers(await fetchParsers());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load parsers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { parsers, error, loading, reload };
}
