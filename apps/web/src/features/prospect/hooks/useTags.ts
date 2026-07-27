// useTags.ts — the workspace's tags for the prospect filter rail (ADR-0028, G-REV-6), and the resolution of
// the record ids matching the currently-selected tag ids (filter-by-tag is list-only: the page filters the
// loaded rows against this union). A tag failing to load is not fatal — the rail just omits the facet.
"use client";

import type { Tag } from "@leadwolf/types";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { fetchRecordsByTag, fetchTags } from "../api";
import { prospectKeys } from "../keys";

export function useTags() {
  const query = useQuery<Tag[]>({ queryKey: prospectKeys.tags(), queryFn: fetchTags });

  return {
    tags: query.data ?? [],
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Could not load tags"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
  };
}

/**
 * Resolve the union of record ids carrying ANY of `tagIds` (OR semantics). Returns null when nothing is
 * selected (no tag filter). Contact entity only at MVP (accounts later).
 *
 * One query PER TAG rather than one for the selection, which is what makes this cheap: toggling a fifth tag
 * on re-reads that tag alone, and toggling it back off costs nothing at all. The previous version re-fetched
 * every selected tag on every change of the selection.
 *
 * A failed tag contributes nothing rather than blanking the union — same intent as the allSettled it
 * replaces: a transient failure on one facet degrades gracefully instead of failing the selection closed.
 */
export function useTaggedIds(tagIds: string[]): Set<string> | null {
  // Sorted + de-duped so a re-ordered selection is the same set of queries, not a new one.
  const selected = useMemo(() => [...new Set(tagIds)].sort(), [tagIds]);

  const results = useQueries({
    queries: selected.map((id) => ({
      queryKey: prospectKeys.taggedRecords(id),
      queryFn: () => fetchRecordsByTag(id, "contact"),
      retry: false,
    })),
  });

  // Depend on the resolved data, not on the result objects — those are new identities every render.
  const ids = results.map((r) => r.data);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the resolved id arrays, not the wrappers.
  return useMemo(() => {
    if (selected.length === 0) return null;
    const union = new Set<string>();
    for (const list of ids) {
      if (list) for (const id of list) union.add(id);
    }
    return union;
  }, [selected.length, JSON.stringify(ids)]);
}
