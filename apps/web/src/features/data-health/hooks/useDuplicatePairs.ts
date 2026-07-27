// useDuplicatePairs.ts — the workspace's auto-flagged duplicate contact pairs (GET /contacts/duplicates), plus
// the two ways a pair leaves the queue: `unmark` ("this is not a duplicate", which clears the flag server-side)
// and `remove` (the merge verb already tombstoned the loser, so this is a local drop with no network).
//
// Both drop the row by patching the cache rather than a private useState array, so the merge drawer and the
// queue cannot disagree about what is still pending review.
"use client";

import type { DuplicatePairView } from "@leadwolf/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { fetchDuplicatePairs, unmarkDuplicate } from "../api";
import { duplicateKeys } from "../keys";

export function useDuplicatePairs() {
  const qc = useQueryClient();
  const key = duplicateKeys.pairs();
  const query = useQuery<DuplicatePairView[]>({ queryKey: key, queryFn: fetchDuplicatePairs });

  const drop = useCallback(
    (duplicateId: string) => {
      qc.setQueryData<DuplicatePairView[]>(key, (rows) =>
        rows?.filter((p) => p.duplicateId !== duplicateId),
      );
    },
    [qc, key],
  );

  const unmark = useMutation({
    mutationFn: (contactId: string) => unmarkDuplicate(contactId),
    // Dropped only on success — a failed unmark must leave the pair in the queue, or the row disappears while
    // the server still considers it a duplicate.
    onSuccess: (_result, contactId) => drop(contactId),
  });

  return {
    pairs: query.data ?? null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load your duplicate contacts"
      : unmark.error
        ? unmark.error instanceof Error
          ? unmark.error.message
          : "Failed to update this contact"
        : null,
    loading: query.isPending,
    unmarking: unmark.isPending ? (unmark.variables ?? null) : null,
    reload: () => {
      void query.refetch();
    },
    unmark: async (contactId: string) => {
      // The queue tolerates a failed unmark (the row stays); swallow so the caller does not have to.
      await unmark.mutateAsync(contactId).catch(() => undefined);
    },
    remove: drop,
  };
}
