// useDataQualityTrend.ts — loads the per-workspace Data Health trend series (GET /home/data-quality/history).
// Presentation state only; the shape comes from @leadwolf/types. The Freshness-trend card fetches it
// independently of the shared summary because it is a separate endpoint.
"use client";

import { sharedKeys } from "@/lib/queryKeys";
import { useQuery } from "@tanstack/react-query";
import { fetchDataQualityHistory } from "../api";
import type { DataQualityTrendPoint } from "../types";

export function useDataQualityTrend() {
  const query = useQuery<DataQualityTrendPoint[]>({
    queryKey: sharedKeys.dataQualityTrend(),
    queryFn: fetchDataQualityHistory,
  });

  return {
    trend: query.data ?? null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load your data health history"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
  };
}
