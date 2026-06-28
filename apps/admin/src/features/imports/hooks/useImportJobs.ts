// useImportJobs.ts — loads the cross-tenant import-jobs monitor (GET /admin/import-jobs) with loading/error
// state and a `reload` (the admin app's useState convention — NO TanStack). Presentation state only; the typed
// fetch lives in api.ts and the shape comes from the slice's types.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchImportJobs } from "../api";
import type { ImportJobRow } from "../types";

export function useImportJobs() {
  const [jobs, setJobs] = useState<ImportJobRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setJobs(await fetchImportJobs());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load import jobs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { jobs, error, loading, reload };
}
