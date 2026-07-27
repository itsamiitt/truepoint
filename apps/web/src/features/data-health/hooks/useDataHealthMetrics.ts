// useDataHealthMetrics.ts — the per-workspace Data Health rollup (GET /home/data-quality) for the Data Health
// page. Shares its query key with features/home's useDataQuality because it is the SAME endpoint — so the two
// surfaces cannot show two different versions of one number, and moving between them is not a refetch.
"use client";

import { sharedKeys } from "@/lib/queryKeys";
import { useQuery } from "@tanstack/react-query";
import { fetchDataQuality } from "../api";
import type { WorkspaceDataQuality } from "../types";

export function useDataHealthMetrics() {
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
