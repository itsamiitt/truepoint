"use client";

// useApiUsage.ts — the tenant's API usage over a window. Returns the house hook shape every cockpit widget
// uses ({ data, error, loading, reload }) so the card wires into WidgetCard without a translation layer.

import { useQuery } from "@tanstack/react-query";
import { type ApiUsageFeed, fetchApiUsage } from "../api";
import { apiUsageKeys } from "../keys";

export function useApiUsage(days: number) {
  const query = useQuery<ApiUsageFeed>({
    queryKey: apiUsageKeys.window(days),
    queryFn: () => fetchApiUsage(days),
  });

  return {
    feed: query.data ?? null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load API usage"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
  };
}
