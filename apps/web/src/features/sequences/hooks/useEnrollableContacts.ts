// useEnrollableContacts.ts — the workspace's masked contacts, narrowed to revealed rows: the only ones the
// outreach API accepts for enrollment (unrevealed → 422 validation_error). Presentation state only.
//
// The narrowing is a `select`, so the filter runs on cache updates rather than on every render, and the
// unfiltered rows stay in the cache for anything else that wants them.
"use client";

import type { MaskedContact } from "@leadwolf/types";
import { useQuery } from "@tanstack/react-query";
import { fetchContacts } from "../api";
import { sequenceKeys } from "../keys";

export function useEnrollableContacts() {
  const query = useQuery<MaskedContact[], Error, MaskedContact[]>({
    queryKey: sequenceKeys.enrollableContacts(),
    // Wrapped, not passed by reference: fetchContacts takes an optional `limit`, and RQ calls queryFn with
    // its context object — which would arrive as that argument.
    queryFn: () => fetchContacts(),
    select: (rows) => rows.filter((c) => c.isRevealed),
  });

  return {
    enrollable: query.data ?? [],
    error: query.error ? query.error.message : null,
    loading: query.isPending,
  };
}
