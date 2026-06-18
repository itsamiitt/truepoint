// useSavedSearches.ts — loads + mutates the workspace's saved searches (24 §8) for the prospect rail. Holds
// the list, exposes create/rename/delete, and keeps local state in sync with the server response (the server
// is authoritative — it stamps `isOwner` and the normalized filter blob). Applying a saved search is the
// caller's job (feed `filters` into useContactSearch's setText/setFilters); this hook only manages the list.
"use client";

import type { ContactQuery, SavedSearch, SavedSearchVisibility } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import {
  createSavedSearch as apiCreate,
  deleteSavedSearch as apiDelete,
  listSavedSearches as apiList,
  updateSavedSearch as apiUpdate,
} from "../savedSearchApi";

export function useSavedSearches() {
  const [searches, setSearches] = useState<SavedSearch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSearches(await apiList());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load saved searches");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Save the active filter set; prepends the new row (newest-first, matching the server order). */
  const create = useCallback(
    async (name: string, filters: ContactQuery, visibility: SavedSearchVisibility) => {
      const saved = await apiCreate({ name, filters, visibility });
      setSearches((prev) => [saved, ...prev]);
      return saved;
    },
    [],
  );

  const rename = useCallback(async (id: string, name: string) => {
    const updated = await apiUpdate(id, { name });
    setSearches((prev) => prev.map((s) => (s.id === id ? updated : s)));
    return updated;
  }, []);

  const remove = useCallback(async (id: string) => {
    await apiDelete(id);
    setSearches((prev) => prev.filter((s) => s.id !== id));
  }, []);

  return { searches, loading, error, reload, create, rename, remove };
}
