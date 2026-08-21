// useListMembers.ts — the engine for the list-detail members grid: MASKED, keyset-paged members for one list,
// the four-state signals, keyset "load more", and a reload the remove-from-list action calls after a mutation.
// The members are masked (email domain only, phone locked) — reveal is the only de-masking path, never this read.
//
// A `useInfiniteQuery`, like its prospect-search sibling: page accumulation and cursor tracking were both
// hand-rolled here. Keying by list id also removes a real hazard in the old version — it accumulated pages
// into one useState and re-ran on id change, so nothing structurally prevented a slow first page of the
// previous list from appending onto the new one.
"use client";

import type { MaskedContact } from "@leadwolf/types";
import { keepPreviousData, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { fetchListMembers } from "../api";
import { listKeys } from "../keys";

const PAGE_SIZE = 100;

export interface ListMembersState {
  members: MaskedContact[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
  /** Optimistically flip a row to revealed after a successful reveal (no refetch). */
  markRevealed: (id: string) => void;
}

type MembersPage = Awaited<ReturnType<typeof fetchListMembers>>;

export function useListMembers(listId: string): ListMembersState {
  const qc = useQueryClient();
  // Memoized because the factory returns a NEW array each call: without this `markRevealed` below would be
  // rebuilt on every render, and it is passed down to the grid rows.
  const queryKey = useMemo(() => listKeys.members(listId), [listId]);

  const query = useInfiniteQuery<MembersPage>({
    queryKey,
    initialPageParam: null,
    // Switching lists is a NEW key — hold the previous list's rows while the fresh page lands instead of
    // strobing the grid to a skeleton (the useProspectSearch treatment; perf-checklist PA-8).
    placeholderData: keepPreviousData,
    // Members pages are big and re-entered often (list → record → back): keep them for 10 minutes instead
    // of the 5-minute default so back-navigation is instant rather than a refetch of a dropped cache.
    gcTime: 10 * 60_000,
    queryFn: ({ pageParam }) =>
      fetchListMembers(listId, {
        limit: PAGE_SIZE,
        cursor: (pageParam as string | null) ?? undefined,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const members = useMemo(
    () => query.data?.pages.flatMap((page) => page.members) ?? [],
    [query.data],
  );

  const markRevealed = useCallback(
    (id: string) => {
      qc.setQueryData<{ pages: MembersPage[]; pageParams: unknown[] }>(
        queryKey,
        (old) =>
          old && {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              members: page.members.map((m) => (m.id === id ? { ...m, isRevealed: true } : m)),
            })),
          },
      );
    },
    [qc, queryKey],
  );

  return {
    members,
    loading: query.isPending,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Could not load list members"
      : null,
    hasMore: query.hasNextPage,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
    reload: () => {
      void query.refetch();
    },
    markRevealed,
  };
}
