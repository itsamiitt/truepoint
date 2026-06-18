// useSessions.ts — loads the workspace's active member sessions (GET /workspaces/security/sessions) with
// loading/error + reload, plus revoke / force-reauth mutators that refresh on success. Presentation state
// only — authorization + auditing live in the API/core layers (G-AUTH-2).
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchSessions, forceReauthMember, revokeSession } from "../api";
import type { SessionsFeed } from "../types";

export function useSessions() {
  const [feed, setFeed] = useState<SessionsFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setFeed(await fetchSessions());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const revoke = useCallback(
    async (sessionId: string): Promise<boolean> => {
      const { ok } = await revokeSession(sessionId);
      if (ok) await reload();
      return ok;
    },
    [reload],
  );

  const forceReauth = useCallback(
    async (userId: string): Promise<boolean> => {
      const { ok } = await forceReauthMember(userId);
      if (ok) await reload();
      return ok;
    },
    [reload],
  );

  return { feed, error, loading, reload, revoke, forceReauth };
}
