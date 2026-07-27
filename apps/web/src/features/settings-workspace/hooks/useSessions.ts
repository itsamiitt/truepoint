// useSessions.ts — the workspace's active member sessions (GET /workspaces/security/sessions) plus revoke /
// force-reauth. Presentation state only — authorization and auditing live in the API/core layers (G-AUTH-2).
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchSessions, forceReauthMember, revokeSession } from "../api";
import { settingsWorkspaceKeys } from "../keys";
import type { SessionsFeed } from "../types";

export function useSessions() {
  const qc = useQueryClient();
  const key = settingsWorkspaceKeys.sessions();
  const query = useQuery<SessionsFeed>({ queryKey: key, queryFn: fetchSessions });

  // Refreshed from the SERVER after a revoke rather than dropped locally: which sessions a revoke actually
  // ended is the server's answer, and a security surface showing a stale "still active" row is the one thing
  // it must not do.
  const refreshIfOk = ({ ok }: { ok: boolean }) => {
    if (ok) void qc.invalidateQueries({ queryKey: key });
  };

  const revoke = useMutation({ mutationFn: revokeSession, onSuccess: refreshIfOk });
  const forceReauth = useMutation({ mutationFn: forceReauthMember, onSuccess: refreshIfOk });

  return {
    feed: query.data ?? null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load sessions"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
    revoke: async (sessionId: string): Promise<boolean> => (await revoke.mutateAsync(sessionId)).ok,
    forceReauth: async (userId: string): Promise<boolean> =>
      (await forceReauth.mutateAsync(userId)).ok,
  };
}
