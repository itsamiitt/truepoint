// useSequences.ts — the workspace's sequences for the list view, plus the pause/resume action (PATCH status)
// with per-row in-flight tracking so the list can disable just the row that is flipping. Presentation state
// only; the outreach engine lives server-side (ADR-0009).
//
// `loading` is the cold load only — a refresh after create/step/enroll keeps the rows on screen, which is what
// the hand-rolled "quiet reload" (never setting loading back to true) was arranging.
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchSequences, setSequenceStatus } from "../api";
import { sequenceKeys } from "../keys";
import type { SequenceStatus, SequenceSummary } from "../types";

export function useSequences() {
  const qc = useQueryClient();
  const key = sequenceKeys.list();
  const query = useQuery<SequenceSummary[]>({ queryKey: key, queryFn: fetchSequences });

  const setStatusMutation = useMutation({
    mutationFn: (vars: { id: string; status: SequenceStatus }) =>
      setSequenceStatus(vars.id, vars.status),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  return {
    sequences: query.data ?? [],
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load sequences"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
    /** Flip a sequence between active and paused. */
    setStatus: async (id: string, status: SequenceStatus): Promise<boolean> => {
      try {
        await setStatusMutation.mutateAsync({ id, status });
        return true;
      } catch {
        // Surfaced through actionError — a failed flip is a row-level problem, not a page error.
        return false;
      }
    },
    pendingId: setStatusMutation.isPending ? (setStatusMutation.variables?.id ?? null) : null,
    actionError: setStatusMutation.error
      ? setStatusMutation.error instanceof Error
        ? setStatusMutation.error.message
        : "Could not update the sequence"
      : null,
  };
}
