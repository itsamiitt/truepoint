// useDataHealthTrend.ts — the per-workspace Data Health trend series (GET /home/data-quality/history). Shares
// its query key with features/home's useDataQualityTrend — same endpoint, one cache entry.
"use client";

import { sharedKeys } from "@/lib/queryKeys";
import { useQuery } from "@tanstack/react-query";
import { fetchDataQualityHistory } from "../api";
import type { DataQualityTrendPoint } from "../types";

export function useDataHealthTrend() {
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
