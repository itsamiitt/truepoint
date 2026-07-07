// useMergePreview.ts — the side-by-side merge preview for the review drawer (11 §5.2; S-U8). TanStack useQuery
// over GET /contacts/:survivor/merge-preview?loser=… — enabled only while a pair is open. A gate-off 404
// (MergeNotEnabledError) is a TERMINAL answer, never retried (the useImportJobs not-enabled precedent): the
// drawer renders the honest "not enabled" state and the caller hides the Merge affordance.
"use client";

import { useQuery } from "@tanstack/react-query";
import { duplicateKeys } from "../keys";
import { fetchMergePreview } from "../mergeApi";

export function useMergePreview(survivorId: string | null, loserId: string | null) {
  return useQuery({
    queryKey: duplicateKeys.mergePreview(survivorId ?? "", loserId ?? ""),
    queryFn: () => fetchMergePreview(survivorId as string, loserId as string),
    enabled: Boolean(survivorId) && Boolean(loserId),
    retry: (count, err) => {
      if ((err as { notEnabled?: boolean })?.notEnabled) return false; // not-enabled: don't hammer the 404
      return count < 2;
    },
  });
}
