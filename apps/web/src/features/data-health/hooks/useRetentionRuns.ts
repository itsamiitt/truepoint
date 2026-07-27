// useRetentionRuns.ts — the per-tenant retention-engine run audit (GET /home/data-quality/retention-runs).
// Presentation state only; the shape comes from @leadwolf/types.
"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchRetentionRuns } from "../api";
import { duplicateKeys } from "../keys";
import type { RetentionRun } from "../types";

export function useRetentionRuns() {
  const query = useQuery<RetentionRun[]>({
    queryKey: duplicateKeys.retentionRuns(),
    queryFn: fetchRetentionRuns,
  });

  return {
    runs: query.data ?? null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load your retention activity"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
  };
}
