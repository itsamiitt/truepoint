// useInbox.ts — the reply threads for the active filter (GET /inbox). Presentation state only; the typed
// fetch lives in api.ts. Keyed by filter, so switching back to a filter already looked at is instant instead
// of a fresh round trip.
"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchThreads } from "../api";
import { inboxKeys } from "../keys";
import type { InboxFeed, InboxFilter } from "../types";

export function useInbox(filter: InboxFilter) {
  const query = useQuery<InboxFeed>({
    queryKey: inboxKeys.threads(filter),
    queryFn: () => fetchThreads(filter),
  });

  return {
    feed: query.data ?? null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load your inbox"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
  };
}
