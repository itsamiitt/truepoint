// useCrmConflicts.ts — the conflict review queue + the resolve mutation (GET/PATCH /crm/conflicts).
//
// The mutation invalidates the queue key on settle, so a resolved row leaves the list without a manual
// refetch. Deliberately NOT optimistic: the server refuses a second transition on an already-closed row, so
// an optimistic removal would show success for a decision another reviewer had already made.
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchCrmConflicts, resolveCrmConflict } from "../api";
import { crmSyncKeys } from "../keys";
import type { CrmConflictView } from "../types";

export function useCrmConflicts() {
  const queryClient = useQueryClient();

  const query = useQuery<CrmConflictView[]>({
    queryKey: crmSyncKeys.conflicts(),
    queryFn: fetchCrmConflicts,
  });

  const mutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "resolved" | "ignored" }) =>
      resolveCrmConflict(id, status),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: crmSyncKeys.conflicts() });
    },
  });

  return {
    conflicts: query.data ?? null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load the review queue"
      : null,
    loading: query.isPending,
    resolving: mutation.isPending,
    resolveError: mutation.error instanceof Error ? mutation.error.message : null,
    resolve: (id: string, status: "resolved" | "ignored") => mutation.mutate({ id, status }),
    reload: () => {
      void query.refetch();
    },
  };
}
