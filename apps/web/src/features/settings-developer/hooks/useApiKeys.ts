// useApiKeys.ts — the tenant's API keys (GET /tenants/me/api-keys) plus create / rotate / revoke. Create and
// rotate return the one-time secret to the CALLER (shown once) and it is deliberately never cached: the query
// entry holds the key metadata the list renders, and a secret sitting in a cache that survives navigation is
// exactly the thing "shown once" is meant to prevent.
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createApiKey, fetchApiKeys, revokeApiKey, rotateApiKey } from "../api";
import { settingsDeveloperKeys } from "../keys";
import type { ApiKeyScope, ApiKeySecret, ApiKeysFeed } from "../types";

export function useApiKeys() {
  const qc = useQueryClient();
  const key = settingsDeveloperKeys.apiKeys();
  const query = useQuery<ApiKeysFeed>({ queryKey: key, queryFn: fetchApiKeys });

  const refreshIfOk = ({ ok }: { ok: boolean }) => {
    if (ok) void qc.invalidateQueries({ queryKey: key });
  };

  const create = useMutation({
    mutationFn: (vars: { name: string; scopes: ApiKeyScope[] }) =>
      createApiKey(vars.name, vars.scopes),
    onSuccess: refreshIfOk,
  });
  const rotate = useMutation({ mutationFn: rotateApiKey, onSuccess: refreshIfOk });
  const revoke = useMutation({ mutationFn: revokeApiKey, onSuccess: refreshIfOk });

  return {
    feed: query.data ?? null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load API keys"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
    create: (name: string, scopes: ApiKeyScope[]): Promise<ApiKeySecret> =>
      create.mutateAsync({ name, scopes }),
    rotate: (id: string): Promise<ApiKeySecret> => rotate.mutateAsync(id),
    revoke: async (id: string): Promise<boolean> => (await revoke.mutateAsync(id)).ok,
  };
}
