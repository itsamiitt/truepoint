// useLists.ts — the engine for the Lists index grid: the workspace's lists, the four-state signals, and a
// reload the CRUD actions call after a mutation so the list (and its member counts) re-reads from the server.
// Lists are workspace-shared; ownership is a per-row flag.
"use client";

import type { List } from "@leadwolf/types";
import { useQuery } from "@tanstack/react-query";
import { fetchLists } from "../api";
import { listKeys } from "../keys";

export interface ListsState {
  lists: List[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useLists(): ListsState {
  const query = useQuery<List[]>({ queryKey: listKeys.index(), queryFn: fetchLists });

  return {
    lists: query.data ?? [],
    loading: query.isPending,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Could not load lists"
      : null,
    reload: () => {
      void query.refetch();
    },
  };
}
