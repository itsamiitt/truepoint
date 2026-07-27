// useList.ts — one list's metadata (name, description, member count, owner) for the detail header.
//
// The lists API has no per-id GET — `fetchList` fetches the whole workspace index and finds the row — so this
// reads the INDEX query and selects from it rather than keeping a second cache entry over the same endpoint.
// That is one request instead of two on a detail page, and it makes the header and the index structurally
// incapable of disagreeing: a rename invalidates one key and both update.
//
// A missing id resolves to `notFound` so the detail surface renders an honest not-found state. That is carried
// as DATA, not as an error: an absent list is a valid answer from a working endpoint, and modelling it as an
// error would put it behind RQ's retry and error handling.
"use client";

import type { List } from "@leadwolf/types";
import { useQuery } from "@tanstack/react-query";
import { fetchLists } from "../api";
import { listKeys } from "../keys";

export interface ListState {
  list: List | null;
  loading: boolean;
  error: string | null;
  notFound: boolean;
  reload: () => void;
}

export function useList(id: string): ListState {
  const query = useQuery<List[], Error, List | null>({
    queryKey: listKeys.index(),
    queryFn: fetchLists,
    select: (lists) => lists.find((l) => l.id === id) ?? null,
  });

  return {
    list: query.data ?? null,
    loading: query.isPending,
    error: query.error ? query.error.message : null,
    notFound: !query.isPending && !query.error && query.data === null,
    reload: () => {
      void query.refetch();
    },
  };
}
