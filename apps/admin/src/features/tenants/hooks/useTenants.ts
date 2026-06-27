// useTenants.ts — loads the cross-tenant directory (GET /admin/tenants) with a server-side search and keyset
// "Load more" pagination (13a F5). Holds the active search, the next-page cursor, and separate loading (initial
// / re-search) vs loadingMore (append) flags. Presentation state only; the typed fetch lives in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchTenants } from "../api";
import type { TenantRow } from "../types";

export function useTenants() {
  const [tenants, setTenants] = useState<TenantRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchTenants(q || undefined);
      setTenants(page.tenants);
      setNextCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tenants");
    } finally {
      setLoading(false);
    }
  }, []);

  const applySearch = useCallback(
    (q: string) => {
      setSearch(q);
      void load(q);
    },
    [load],
  );

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchTenants(search || undefined, nextCursor);
      setTenants((prev) => [...(prev ?? []), ...page.tenants]);
      setNextCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }, [search, nextCursor]);

  useEffect(() => {
    void load("");
  }, [load]);

  return {
    tenants,
    nextCursor,
    search,
    error,
    loading,
    loadingMore,
    applySearch,
    loadMore,
    reload: useCallback(() => load(search), [load, search]),
  };
}
