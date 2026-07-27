// useMembers.ts — the workspace members (GET /workspaces/current/members) plus invite / change-role / remove.
// Presentation state only.
//
// Each mutator invalidates on success, which is what the `if (ok) await reload()` chain did — the difference
// is that invalidation refreshes every mounted reader of the members feed, not just the hook instance the
// action happened to be called from.
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchMembers, inviteMember, removeMember, updateMemberRole } from "../api";
import { settingsWorkspaceKeys } from "../keys";
import type { MembersFeed, WorkspaceRole } from "../types";

export function useMembers() {
  const qc = useQueryClient();
  const key = settingsWorkspaceKeys.members();
  const query = useQuery<MembersFeed>({ queryKey: key, queryFn: fetchMembers });

  const refreshIfOk = ({ ok }: { ok: boolean }) => {
    if (ok) void qc.invalidateQueries({ queryKey: key });
  };

  const invite = useMutation({
    mutationFn: (vars: { email: string; role: WorkspaceRole }) =>
      inviteMember(vars.email, vars.role),
    onSuccess: refreshIfOk,
  });
  const changeRole = useMutation({
    mutationFn: (vars: { id: string; role: WorkspaceRole }) => updateMemberRole(vars.id, vars.role),
    onSuccess: refreshIfOk,
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeMember(id),
    onSuccess: refreshIfOk,
  });

  return {
    feed: query.data ?? null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load members"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
    invite: async (email: string, role: WorkspaceRole): Promise<boolean> =>
      (await invite.mutateAsync({ email, role })).ok,
    changeRole: async (id: string, role: WorkspaceRole): Promise<boolean> =>
      (await changeRole.mutateAsync({ id, role })).ok,
    remove: async (id: string): Promise<boolean> => (await remove.mutateAsync(id)).ok,
  };
}
