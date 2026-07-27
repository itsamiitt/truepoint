// useWorkspace.ts — the workspace's general settings.
//
// A null value from the endpoint is how a not-built backend reports itself, so it is carried as `available`
// rather than an error. A successful save invalidates — previously it returned ok and left the pre-save value
// on screen until something else reloaded it.
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchWorkspace, saveWorkspace } from "../api";
import { settingsWorkspaceKeys } from "../keys";
import type { WorkspaceGeneral } from "../types";

export function useWorkspace() {
  const qc = useQueryClient();
  const query = useQuery<WorkspaceGeneral | null>({
    queryKey: settingsWorkspaceKeys.general(),
    queryFn: fetchWorkspace,
  });

  const save = useMutation({
    mutationFn: (patch: Partial<WorkspaceGeneral>) => saveWorkspace(patch),
    onSuccess: ({ ok }) => {
      if (ok) void qc.invalidateQueries({ queryKey: settingsWorkspaceKeys.general() });
    },
  });

  return {
    data: query.data ?? null,
    available: query.data !== undefined ? query.data !== null : true,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load workspace settings"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
    save: async (patch: Partial<WorkspaceGeneral>): Promise<boolean> =>
      (await save.mutateAsync(patch)).ok,
  };
}
