// useImportMutations.ts — the actor verbs on a durable job (cancel · retry-failed). Server-truth everywhere:
// no optimistic job-state edits (a job is a server fact) — the mutation shows in-flight button state, then
// invalidates the list + detail so the next poll re-reads the truth (11 §pre-build). Idempotency-Key on the
// retry makes a double-click return the same child.
"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { cancelImportJob, retryFailedRows } from "../apiV2";
import { importKeys } from "../keys";

export function useCancelImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => cancelImportJob(jobId),
    onSuccess: () => qc.invalidateQueries({ queryKey: importKeys.all }),
  });
}

export function useRetryFailed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => retryFailedRows(jobId),
    onSuccess: () => qc.invalidateQueries({ queryKey: importKeys.all }),
  });
}
