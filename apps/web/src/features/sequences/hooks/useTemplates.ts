// useTemplates.ts — the message-template library for the Templates panel (M12 P2; 11 §4.3): keyset pagination
// plus a `status` filter (active library vs archived bin, so an archive is reversible from the UI). The
// backend is LIVE, so `available` defaults true and only flips false if the endpoint 404/501s (an older
// deploy). Presentation state only.
//
// A `useInfiniteQuery` keyed by status. The separation the hand-rolled version was careful about survives: a
// failed "load more" surfaces on its OWN `loadMoreError` and never tears down the already-loaded grid, while
// the page-1 `error` drives the full-panel StateSwitch. RQ keeps the loaded pages on a failed fetchNextPage,
// so that property now holds structurally rather than by the catch leaving `data` alone.
"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { fetchTemplates } from "../api";
import { sequenceKeys } from "../keys";
import type { TemplateStatus, TemplateSummary } from "../types";

type TemplatePage = Awaited<ReturnType<typeof fetchTemplates>>;

export function useTemplates() {
  // The status filter is CLIENT state (what the user picked); the templates it selects are server state.
  const [status, setStatus] = useState<TemplateStatus>("active");

  const query = useInfiniteQuery<TemplatePage>({
    queryKey: sequenceKeys.templates(status),
    initialPageParam: undefined,
    queryFn: ({ pageParam }) => fetchTemplates({ status, cursor: pageParam as string | undefined }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const data = useMemo<TemplateSummary[]>(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );

  const pageOneFailed = query.isError && !query.data;

  return {
    data,
    status,
    setStatus,
    available: query.data?.pages[0]?.available ?? true,
    nextCursor: query.hasNextPage ? (query.data?.pages.at(-1)?.nextCursor ?? null) : null,
    loading: query.isPending,
    loadingMore: query.isFetchingNextPage,
    // Only a failed FIRST page is a panel-level error; anything else keeps the grid and reports below it.
    error: pageOneFailed
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load templates"
      : null,
    loadMoreError:
      query.isError && query.data
        ? query.error instanceof Error
          ? query.error.message
          : "Failed to load more templates"
        : null,
    reload: () => {
      void query.refetch();
    },
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
  };
}
