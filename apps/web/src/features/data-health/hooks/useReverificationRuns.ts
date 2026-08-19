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
    // A run's ledger row lands when the run (or a deadline-split attempt of it) finishes — there is no push
    // channel for it yet, and without a poll the "Results appear here as runs complete" toast was a promise
    // the client never kept: rows only appeared on a manual reload (perf-audit P1.5). 15s while this tab is
    // mounted is 4 req/min on an admin-only surface; RQ pauses it when the tab is hidden.
    refetchInterval: 15_000,
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
