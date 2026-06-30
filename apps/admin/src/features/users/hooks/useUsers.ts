// useUsers.ts — loads the cross-tenant user directory (GET /admin/users) with a server-side email/name search
// and keyset "Load more" pagination (13a F5). Holds the active search, the next-page cursor, and separate
// loading (initial / re-search) vs loadingMore (append) flags. Presentation state only; fetch lives in api.ts.
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
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (q: string, st: string) => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchUsers({ search: q || undefined, status: st || undefined });
      setUsers(page.users);
      setNextCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load users");
    } finally {
      setLoading(false);
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
    setError(null);
    try {
      const page = await fetchUsers({
        search: search || undefined,
        status: status || undefined,
        cursor: nextCursor,
      });
      setUsers((prev) => [...(prev ?? []), ...page.users]);
      setNextCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load more");
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
    loadingMore,
    applySearch,
    applyStatus,
    loadMore,
    reload: useCallback(() => load(search, status), [load, search, status]),
  };
}
