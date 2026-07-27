// useDataQuality.ts — loads the per-workspace Data Health rollup (GET /home/data-quality). Presentation state
// only; the shape comes from @leadwolf/types. A separate query from the cockpit summary because it is a
// separate endpoint — but now a real cache entry, so two cards mounting it share one request instead of two.
"use client";

import { sharedKeys } from "@/lib/queryKeys";
import { useQuery } from "@tanstack/react-query";
import { fetchDataQuality } from "../api";
import type { WorkspaceDataQuality } from "../types";

export function useDataQuality() {
  const query = useQuery<WorkspaceDataQuality>({
    queryKey: sharedKeys.dataQuality(),
    queryFn: fetchDataQuality,
  });

  return {
    metrics: query.data ?? null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load your data health"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
  };
}
