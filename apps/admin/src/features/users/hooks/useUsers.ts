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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchUsers(q || undefined);
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
      void load(q);
    },
    [load],
  );

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchUsers(search || undefined, nextCursor);
      setUsers((prev) => [...(prev ?? []), ...page.users]);
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
    users,
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
