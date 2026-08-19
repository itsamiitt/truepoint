// useUsers.ts — loads the cross-tenant user directory (GET /admin/users) with a server-side email/name search
// and keyset "Load more" pagination (13a F5). Holds the active search, the next-page cursor, and separate
// loading (initial / re-search) vs refreshing (post-mutation reload) vs loadingMore (append) flags.
// Presentation state only; fetch lives in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchUsers } from "../api";
import type { PlatformUser } from "../types";

export function useUsers() {
  const [users, setUsers] = useState<PlatformUser[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Post-mutation reloads report here — re-raising `loading` would blank the populated table back to the
  // StateSwitch skeleton (perf-audit P3.6). A re-search still raises `loading` (the result set is replaced).
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const load = useCallback(async (q: string, st: string, opts?: { refresh?: boolean }) => {
    if (opts?.refresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const page = await fetchUsers({ search: q || undefined, status: st || undefined });
      setUsers(page.users);
      setNextCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load users");
    } finally {
      if (opts?.refresh) setRefreshing(false);
      else setLoading(false);
    }
  }, []);

  const applySearch = useCallback(
    (q: string) => {
      setSearch(q);
      void load(q, status);
    },
    [load, status],
  );

  const applyStatus = useCallback(
    (st: string) => {
      setStatus(st);
      void load(search, st);
    },
    [load, search],
  );

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await fetchUsers({
        search: search || undefined,
        status: status || undefined,
        cursor: nextCursor,
      });
      setUsers((prev) => [...(prev ?? []), ...page.users]);
      setNextCursor(page.nextCursor);
    } catch (e) {
      // A pagination failure must NOT wipe the loaded list (the page `error` drives StateSwitch). Inline it.
      setLoadMoreError(e instanceof Error ? e.message : "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }, [search, status, nextCursor]);

  useEffect(() => {
    void load("", "");
  }, [load]);

  return {
    users,
    nextCursor,
    search,
    status,
    error,
    loading,
    refreshing,
    loadingMore,
    loadMoreError,
    applySearch,
    applyStatus,
    loadMore,
    reload: useCallback(() => load(search, status, { refresh: true }), [load, search, status]),
  };
}
