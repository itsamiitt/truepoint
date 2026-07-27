// useSavedSearches.ts — the viewer's saved filter sets: the list plus create/rename/delete.
//
// The three writes patch the cache directly rather than refetching the list, which is what the previous
// setSearches calls did — the difference is that the patched value is now the SAME entry every other reader
// sees, instead of one component's private copy of the array.
"use client";

import type { ContactQuery, SavedSearch, SavedSearchVisibility } from "@leadwolf/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { prospectKeys } from "../keys";
import {
  createSavedSearch as apiCreate,
  deleteSavedSearch as apiDelete,
  listSavedSearches as apiList,
  updateSavedSearch as apiUpdate,
} from "../savedSearchApi";

export function useSavedSearches() {
  const qc = useQueryClient();
  const key = prospectKeys.savedSearches();
  const query = useQuery<SavedSearch[]>({ queryKey: key, queryFn: apiList });

  const patch = (fn: (rows: SavedSearch[]) => SavedSearch[]) => {
    qc.setQueryData<SavedSearch[]>(key, (old) => fn(old ?? []));
  };

  const create = useMutation({
    mutationFn: (vars: {
      name: string;
      filters: ContactQuery;
      visibility: SavedSearchVisibility;
    }) => apiCreate(vars),
    // Prepend, matching the server's newest-first order.
    onSuccess: (saved) => patch((rows) => [saved, ...rows]),
  });

  const rename = useMutation({
    mutationFn: (vars: { id: string; name: string }) => apiUpdate(vars.id, { name: vars.name }),
    onSuccess: (updated) => patch((rows) => rows.map((s) => (s.id === updated.id ? updated : s))),
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiDelete(id),
    onSuccess: (_result, id) => patch((rows) => rows.filter((s) => s.id !== id)),
  });

  return {
    searches: query.data ?? [],
    loading: query.isPending,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Could not load saved searches"
      : null,
    reload: () => {
      void query.refetch();
    },
    create: (name: string, filters: ContactQuery, visibility: SavedSearchVisibility) =>
      create.mutateAsync({ name, filters, visibility }),
    rename: (id: string, name: string) => rename.mutateAsync({ id, name }),
    remove: (id: string) => remove.mutateAsync(id),
  };
}
