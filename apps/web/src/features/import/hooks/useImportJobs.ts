// useImportJobs.ts — the durable import history list (import-redesign 11 §2.2, S-U2). Keyset pagination via
// TanStack's useInfiniteQuery: each page is `GET /imports?cursor=…`, the opaque `nextCursor` drives "Load more"
// (never OFFSET — 12 §keyset mandate). ONE list-level poll (10 s while any LOADED row is still running, else
// off — never a per-row poller, 11 §2.2). A gate-off 404 (ImportsNotEnabledError) is a terminal answer, never
// retried — the list treats it as an honest "not enabled" state, not a failure.
"use client";

import { type InfiniteData, useInfiniteQuery } from "@tanstack/react-query";
import type { ImportJobListItem, ImportJobListResponse } from "@leadwolf/types";
import { fetchImportJobs } from "../apiV2";
import { isTerminalV2 } from "../components/shared/stateCopy";
import { importKeys } from "../keys";

/** A running row on ANY loaded page keeps the whole list polling (a new page can add fresh in-flight jobs). */
function anyRunning(data: InfiniteData<ImportJobListResponse> | undefined): boolean {
  return data?.pages.some((p) => p.jobs.some((j) => !isTerminalV2(j.status))) ?? false;
}

export function useImportJobs() {
  const query = useInfiniteQuery({
    queryKey: importKeys.list(),
    queryFn: ({ pageParam }) => fetchImportJobs(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last: ImportJobListResponse) => last.nextCursor,
    refetchInterval: (q) => (anyRunning(q.state.data) ? 10_000 : false),
    retry: (count, err) => {
      if ((err as { notEnabled?: boolean })?.notEnabled) return false; // not-enabled: don't hammer the 404
      return count < 2;
    },
  });

  // Flatten the loaded pages into one row list for the table (keyset order is preserved across pages).
  const jobs: ImportJobListItem[] = query.data?.pages.flatMap((p) => p.jobs) ?? [];
  return { ...query, jobs };
}
