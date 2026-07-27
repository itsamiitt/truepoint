// useScores.ts — a contact's newest-first lead-score history for the record-detail Drawer (ADR-0008). The
// score breakdown (composite + icp/intent/engagement) is opaque to the UI; this hook only fetches and exposes
// view state. Presentation state only.
"use client";

import { useQuery } from "@tanstack/react-query";
import { type ScoreHistoryRow, fetchScores } from "../api";
import { prospectKeys } from "../keys";

export function useScores(contactId: string | null) {
  const query = useQuery<ScoreHistoryRow[]>({
    queryKey: prospectKeys.scores(contactId ?? ""),
    // No contact selected is not a load — the drawer is closed.
    enabled: contactId !== null,
    queryFn: () => fetchScores(contactId as string),
  });

  return {
    scores: contactId ? (query.data ?? null) : null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Could not load scores"
      : null,
    loading: query.isPending && contactId !== null,
    reload: () => {
      void query.refetch();
    },
  };
}
