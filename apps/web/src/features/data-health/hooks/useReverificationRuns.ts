// useReverificationRuns.ts — the per-workspace freshness re-verification runs
// (GET /home/data-quality/reverification-runs). Presentation state only; the shape comes from @leadwolf/types.
"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchReverificationRuns } from "../api";
import { duplicateKeys } from "../keys";
import type { ReverificationRun } from "../types";

export function useReverificationRuns() {
  const query = useQuery<ReverificationRun[]>({
    queryKey: duplicateKeys.reverificationRuns(),
    queryFn: fetchReverificationRuns,
  });

  return {
    runs: query.data ?? null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load your freshness activity"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
  };
}
