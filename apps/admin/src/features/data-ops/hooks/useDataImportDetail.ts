// useDataImportDetail.ts — loads one bulk-import job's drill-down (GET /admin/data/imports/:jobId) with
// loading/error state and a `reload` (the admin app's useState convention — NO TanStack). Re-fetches when the
// jobId changes. Presentation state only; the typed fetch lives in api.ts and the shape comes from the slice's types.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchDataImportDetail } from "../api";
import type { DataImportDetail } from "../types";

export function useDataImportDetail(jobId: string) {
  const [detail, setDetail] = useState<DataImportDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await fetchDataImportDetail(jobId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the import job");
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { detail, error, loading, reload };
}
