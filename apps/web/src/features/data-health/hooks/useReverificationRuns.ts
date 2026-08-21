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
    // the client never kept: rows only appeared on a manual reload (perf-audit P1.5). 60s, not 15
    // (perf-checklist PA-8): every row in this feed is a COMPLETED run (the schema has no in-flight state to
    // key a faster tick off), sweep-driven runs land on multi-minute cadences, and the old 15s was 4 req/min
    // per open tab for a feed that changes a few times an hour. RQ still pauses it when the tab is hidden.
    refetchInterval: 60_000,
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
