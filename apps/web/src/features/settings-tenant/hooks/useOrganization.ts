// useOrganization.ts — the organization profile plus its workspaces and members summary. A backend that has
// not built the value reports it (org null / feed.available false) so the panel degrades to disabled/empty
// states rather than erroring.
//
// The three reads stay one query: they are fetched together, rendered together, and a partial result would
// leave the panel in a state no component handles. A successful save invalidates — previously it returned ok
// and left whatever was on screen, so the panel showed the pre-save value until something else reloaded it.
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchMembersSummary, fetchOrganization, fetchWorkspaces, saveOrganization } from "../api";
import { settingsTenantKeys } from "../keys";
import type { Organization } from "../types";

export function useOrganization() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: settingsTenantKeys.organization(),
    queryFn: async () => {
      const [org, workspaces, members] = await Promise.all([
        fetchOrganization(),
        fetchWorkspaces(),
        fetchMembersSummary(),
      ]);
      return { org, workspaces, members };
    },
  });

  const save = useMutation({
    mutationFn: (patch: Partial<Organization>) => saveOrganization(patch),
    onSuccess: ({ ok }) => {
      if (ok) void qc.invalidateQueries({ queryKey: settingsTenantKeys.organization() });
    },
  });

  return {
    org: query.data?.org ?? null,
    // Distinct from "not loaded": the endpoint answering with no organization is how a not-built backend says
    // so, and the panel disables itself rather than erroring.
    orgAvailable: query.data ? query.data.org != null : true,
    workspaces: query.data?.workspaces ?? null,
    members: query.data?.members ?? null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load organization settings"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
    save: async (patch: Partial<Organization>): Promise<boolean> =>
      (await save.mutateAsync(patch)).ok,
  };
}
