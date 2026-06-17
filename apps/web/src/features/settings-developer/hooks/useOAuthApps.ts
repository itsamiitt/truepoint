// useOAuthApps.ts — loads the tenant's registered OAuth clients (GET /tenants/me/oauth-apps) with loading/error
// + reload, plus register / remove mutators that refresh on success. Register returns the client id + one-time
// client secret to the caller (shown once). Presentation state only; no fabricated credentials.
"use client";

import { useCallback, useEffect, useState } from "react";
import { deleteOAuthApp, fetchOAuthApps, registerOAuthApp } from "../api";
import type { OAuthAppCredentials, OAuthAppsFeed } from "../types";

export function useOAuthApps() {
  const [feed, setFeed] = useState<OAuthAppsFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setFeed(await fetchOAuthApps());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load OAuth apps");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const register = useCallback(
    async (name: string, redirectUris: string[]): Promise<OAuthAppCredentials> => {
      const result = await registerOAuthApp(name, redirectUris);
      if (result.ok) await reload();
      return result;
    },
    [reload],
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      const { ok } = await deleteOAuthApp(id);
      if (ok) await reload();
      return ok;
    },
    [reload],
  );

  return { feed, error, loading, reload, register, remove };
}
