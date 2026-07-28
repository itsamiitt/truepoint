// useCrmMappings.ts — the field-mapping editor's server state (GET/PATCH /crm/mappings).
//
// The mutation invalidates the mapping key on settle rather than optimistically patching the row: a
// mapping decides which of the customer's CRM fields TruePoint may overwrite, and showing a change that the
// server refused (a stale id, a lost role) would be showing them a data policy they do not actually have.
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchCrmMappings, updateCrmMapping } from "../api";
import { crmSyncKeys } from "../keys";
import type { CrmMappingView } from "../types";

export function useCrmMappings(connectionId: string | null) {
  const queryClient = useQueryClient();

  const query = useQuery<CrmMappingView[]>({
    queryKey: crmSyncKeys.mappings(connectionId ?? ""),
    queryFn: () => fetchCrmMappings(connectionId as string),
    enabled: Boolean(connectionId),
  });

  const mutation = useMutation({
    mutationFn: ({
      id,
      patch,
    }: { id: string; patch: { direction?: string; authority?: string; enabled?: boolean } }) =>
      updateCrmMapping(id, patch),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: crmSyncKeys.mappings(connectionId ?? ""),
      });
    },
  });

  return {
    mappings: query.data ?? null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load your field mappings"
      : null,
    loading: query.isPending && Boolean(connectionId),
    saving: mutation.isPending,
    saveError: mutation.error instanceof Error ? mutation.error.message : null,
    update: (id: string, patch: { direction?: string; authority?: string; enabled?: boolean }) =>
      mutation.mutate({ id, patch }),
    reload: () => {
      void query.refetch();
    },
  };
}
