// useMembers.ts — loads the workspace members (GET /workspaces/current/members) with loading/error + reload,
// plus invite / change-role / remove mutators that refresh on success. Presentation state only.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchMembers, inviteMember, removeMember, updateMemberRole } from "../api";
import type { MembersFeed, WorkspaceRole } from "../types";

export function useMembers() {
  const [feed, setFeed] = useState<MembersFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setFeed(await fetchMembers());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load members");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const invite = useCallback(
    async (email: string, role: WorkspaceRole): Promise<boolean> => {
      const { ok } = await inviteMember(email, role);
      if (ok) await reload();
      return ok;
    },
    [reload],
  );

  const changeRole = useCallback(
    async (id: string, role: WorkspaceRole): Promise<boolean> => {
      const { ok } = await updateMemberRole(id, role);
      if (ok) await reload();
      return ok;
    },
    [reload],
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      const { ok } = await removeMember(id);
      if (ok) await reload();
      return ok;
    },
    [reload],
  );

  return { feed, error, loading, reload, invite, changeRole, remove };
}
