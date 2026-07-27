// useDrafts.ts — AI/manual outreach drafts for the draft → review → send seam (05 §13/§16). `available` is
// carried in the query data: the drafts backend is post-MVP, so when it is not wired the API helper resolves
// available=false (not an error) and the panel gates on "review required" without inventing drafts.
//
// There is deliberately NO send action here — sending stays human-reviewed and the send seam is not
// implemented yet.
"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchDrafts } from "../api";
import { sequenceKeys } from "../keys";

export function useDrafts() {
  const query = useQuery({ queryKey: sequenceKeys.drafts(), queryFn: fetchDrafts });

  return {
    data: query.data?.items ?? [],
    // Defaults FALSE: until the feed says otherwise the panel must not present a drafts flow that may not exist.
    available: query.data?.available ?? false,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load drafts"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
  };
}
