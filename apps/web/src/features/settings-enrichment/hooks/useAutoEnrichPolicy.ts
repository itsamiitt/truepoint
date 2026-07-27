// useAutoEnrichPolicy.ts — the tenant's auto-enrich policy.
//
// A null policy from the endpoint is how a not-built backend reports itself, so it is carried as `available`
// rather than an error — and the save answers the same way: null means "the route is not built", which is a
// false return, not a failure. A real save returns the persisted policy, which goes straight into the cache
// (it is the value the server just accepted, so refetching to learn it would be a wasted round trip).
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type AutoEnrichPolicyPatch, fetchAutoEnrichPolicy, saveAutoEnrichPolicy } from "../api";
import { settingsEnrichmentKeys } from "../keys";
import type { AutoEnrichPolicy } from "../types";

export function useAutoEnrichPolicy() {
  const qc = useQueryClient();
  const query = useQuery<AutoEnrichPolicy | null>({
    queryKey: settingsEnrichmentKeys.autoEnrichPolicy(),
    queryFn: fetchAutoEnrichPolicy,
  });

  const save = useMutation({
    mutationFn: (patch: AutoEnrichPolicyPatch) => saveAutoEnrichPolicy(patch),
    onSuccess: (saved) => {
      if (saved) qc.setQueryData(settingsEnrichmentKeys.autoEnrichPolicy(), saved);
    },
  });

  return {
    data: query.data ?? null,
    available: query.data !== undefined ? query.data !== null : true,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load the auto-enrich policy"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
    /** True when persisted; false when the route is not built yet. */
    save: async (patch: AutoEnrichPolicyPatch): Promise<boolean> =>
      (await save.mutateAsync(patch)) != null,
  };
}
