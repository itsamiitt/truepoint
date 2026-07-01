// useUsageHistory.ts — view state for the billing hub's Usage tab: keyset-paginated, filterable credit-usage
// history with a "Load more" cursor and CSV export. Owns its own loading/error so the tab is independent of the
// Plan/Credits load (useBilling). Presentation state only; the reveal accounting is server-side (07 §3).
"use client";

import { useCallback, useEffect, useState } from "react";
import { exportUsageCsv, fetchUsagePage } from "../api";
import type { UsageFilters, UsageReveal } from "../types";

const PAGE_SIZE = 50;

export function useUsageHistory() {
  const [filters, setFilters] = useState<UsageFilters>({});
  const [rows, setRows] = useState<UsageReveal[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (f: UsageFilters) => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchUsagePage({ ...f, limit: PAGE_SIZE });
      setRows(page.reveals);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load usage history");
    } finally {
      setLoading(false);
    }
  }, []);

  // Reload whenever the filter object changes (a new object identity per setFilters call).
  useEffect(() => {
    void load(filters);
  }, [load, filters]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchUsagePage({ ...filters, limit: PAGE_SIZE, cursor });
      setRows((prev) => [...prev, ...page.reveals]);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, filters]);

  const exportCsv = useCallback(async () => {
    setExporting(true);
    setError(null);
    try {
      await exportUsageCsv(filters);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to export usage");
    } finally {
      setExporting(false);
    }
  }, [filters]);

  return {
    rows,
    filters,
    setFilters,
    loading,
    loadingMore,
    exporting,
    error,
    hasMore: cursor != null,
    loadMore,
    exportCsv,
    reload: () => load(filters),
  };
}
