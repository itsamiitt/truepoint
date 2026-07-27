// useUsageHistory.ts — the billing hub's Usage tab: keyset-paginated, filterable credit-usage history with a
// "Load more" cursor and CSV export. Independent of the Plan/Credits load (useBilling). Presentation state
// only; the reveal accounting is server-side (07 §3).
//
// A `useInfiniteQuery` keyed by the filters: page accumulation and the cursor were hand-rolled, and changing a
// filter re-fetched from scratch every time — including going back to a filter set already looked at.
"use client";

import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { exportUsageCsv, fetchUsagePage } from "../api";
import { settingsBillingKeys } from "../keys";
import type { UsageFilters, UsageReveal } from "../types";

const PAGE_SIZE = 50;

type UsagePage = Awaited<ReturnType<typeof fetchUsagePage>>;

export function useUsageHistory() {
  // The filters are CLIENT state (what the user picked); the rows they select are server state.
  const [filters, setFilters] = useState<UsageFilters>({});

  const query = useInfiniteQuery<UsagePage>({
    queryKey: settingsBillingKeys.usage(filters),
    initialPageParam: null,
    queryFn: ({ pageParam }) =>
      fetchUsagePage({
        ...filters,
        limit: PAGE_SIZE,
        cursor: (pageParam as string | null) ?? undefined,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const rows = useMemo<UsageReveal[]>(
    () => query.data?.pages.flatMap((page) => page.reveals) ?? [],
    [query.data],
  );

  const exportCsv = useMutation({ mutationFn: () => exportUsageCsv(filters) });

  const error = query.error ?? exportCsv.error;

  return {
    rows,
    filters,
    setFilters,
    loading: query.isPending,
    loadingMore: query.isFetchingNextPage,
    exporting: exportCsv.isPending,
    error: error ? (error instanceof Error ? error.message : "Failed to load usage history") : null,
    hasMore: query.hasNextPage,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
    exportCsv: () => exportCsv.mutateAsync(),
    reload: () => {
      void query.refetch();
    },
  };
}
