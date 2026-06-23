// useUsers.ts — loads the cross-tenant user directory (GET /admin/users) with loading/error state and a
// `reload`. Presentation state only; the typed fetch lives in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchUsers } from "../api";
import type { PlatformUser } from "../types";

export function useUsers() {
  const [users, setUsers] = useState<PlatformUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUsers(await fetchUsers());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { users, error, loading, reload };
}
