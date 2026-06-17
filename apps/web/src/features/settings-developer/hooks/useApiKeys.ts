// useApiKeys.ts — loads the tenant's API keys (GET /tenants/me/api-keys) with loading/error + reload, plus
// create / rotate / revoke mutators that refresh on success. Create/rotate return the one-time secret to the
// caller (shown once). Presentation state only; no fabricated keys.
"use client";

import { useCallback, useEffect, useState } from "react";
import { createApiKey, fetchApiKeys, revokeApiKey, rotateApiKey } from "../api";
import type { ApiKeyScope, ApiKeySecret, ApiKeysFeed } from "../types";

export function useApiKeys() {
  const [feed, setFeed] = useState<ApiKeysFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setFeed(await fetchApiKeys());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load API keys");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = useCallback(
    async (name: string, scopes: ApiKeyScope[]): Promise<ApiKeySecret> => {
      const result = await createApiKey(name, scopes);
      if (result.ok) await reload();
      return result;
    },
    [reload],
  );

  const rotate = useCallback(
    async (id: string): Promise<ApiKeySecret> => {
      const result = await rotateApiKey(id);
      if (result.ok) await reload();
      return result;
    },
    [reload],
  );

  const revoke = useCallback(
    async (id: string): Promise<boolean> => {
      const { ok } = await revokeApiKey(id);
      if (ok) await reload();
      return ok;
    },
    [reload],
  );

  return { feed, error, loading, reload, create, rotate, revoke };
}
