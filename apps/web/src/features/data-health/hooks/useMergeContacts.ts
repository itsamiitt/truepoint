// useMergeContacts.ts — the IRREVERSIBLE true-merge mutation (11 §5.2; S-U8). Server-truth: no optimistic edit
// (a merge is a server fact) — the confirm button shows in-flight state, then on success the caller drops the
// pair from the queue + this invalidates the duplicate cache. A fresh Idempotency-Key per call (in mergeApi)
// makes a double-submit a safe replay. Mirrors features/import/hooks/useImportMutations.ts.
"use client";

import type { MergeFieldDecision } from "@leadwolf/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { duplicateKeys } from "../keys";
import { mergeContacts } from "../mergeApi";

export function useMergeContacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { survivorId: string; loserContactId: string; decisions: MergeFieldDecision[] }) =>
      mergeContacts(vars.survivorId, {
        loserContactId: vars.loserContactId,
        decisions: vars.decisions,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: duplicateKeys.all }),
  });
}
