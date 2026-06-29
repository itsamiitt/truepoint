// useAuditLog.ts — loads filtered, keyset-paginated platform audit entries (GET /admin/audit-log). Holds the
// active filters, the next-page cursor, and separate `loading` (initial / re-filter) vs `loadingMore` (append)
// flags. Presentation state only; the typed fetch + the CSV export live in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchAuditLog } from "../api";
import type { AuditLogFilters, PlatformAuditEntry } from "../types";

export function useAuditLog() {
  const [entries, setEntries] = useState<PlatformAuditEntry[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filters, setFilters] = useState<AuditLogFilters>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (f: AuditLogFilters) => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchAuditLog(f);
      setEntries(page.entries);
      setNextCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load audit log");
    } finally {
      setLoading(false);
    }
  }, []);

  /** Replace the filters and reload from the first page. */
  const applyFilters = useCallback(
    (f: AuditLogFilters) => {
      setFilters(f);
      void load(f);
    },
    [load],
  );

  /** Append the next keyset page (no-op when there is no cursor). */
  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchAuditLog(filters, nextCursor);
      setEntries((prev) => [...(prev ?? []), ...page.entries]);
      setNextCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }, [filters, nextCursor]);

  useEffect(() => {
    void load({});
  }, [load]);

  return {
    entries,
    nextCursor,
    filters,
    error,
    loading,
    loadingMore,
    applyFilters,
    loadMore,
    reload: useCallback(() => load(filters), [load, filters]),
  };
}
