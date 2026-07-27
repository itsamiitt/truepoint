// useSalesNavLinks.ts — the Sales Navigator capture surface (05 §5, M7): the workspace's captured links plus
// capture/remove. Presentation state only — dedup, parsing and persistence all happen server-side; the hook
// just reflects the result.
"use client";

import type { SalesNavLinkDTO, SalesNavLinkRequest } from "@leadwolf/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { captureLink, deleteLink, fetchLinks } from "../api";
import { salesNavKeys } from "../keys";

export interface CaptureOutcome {
  deduped: boolean;
}

export function useSalesNavLinks() {
  const qc = useQueryClient();
  const key = salesNavKeys.links();
  const query = useQuery<SalesNavLinkDTO[]>({ queryKey: key, queryFn: fetchLinks });

  const capture = useMutation({
    mutationFn: captureLink,
    // Refreshed from the server rather than appended locally: a capture may DEDUPE into an existing row, so
    // what the list should now contain is the server's answer, not the request body.
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  const remove = useMutation({
    mutationFn: deleteLink,
    // Optimistic with a real rollback: the row disappears immediately, and a failed delete puts back exactly
    // the list that was there before rather than re-fetching to discover it.
    onMutate: async (id: string) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<SalesNavLinkDTO[]>(key);
      qc.setQueryData<SalesNavLinkDTO[]>(key, (rows) => rows?.filter((l) => l.id !== id));
      return { previous };
    },
    onError: (_err, _id, context) => {
      if (context?.previous) qc.setQueryData(key, context.previous);
    },
  });

  return {
    links: query.data ?? [],
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load captured links"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
    /** Capture a link; the (possibly deduped) row is reflected once the list refreshes. Throws on failure. */
    capture: async (body: SalesNavLinkRequest): Promise<CaptureOutcome> => {
      const result = await capture.mutateAsync(body);
      return { deduped: result.deduped };
    },
    /** Drop a link. Throws on failure, after rolling the row back. */
    remove: async (id: string): Promise<void> => {
      await remove.mutateAsync(id);
    },
  };
}
