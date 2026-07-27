// useOAuthApps.ts — the tenant's registered OAuth apps plus register / remove. Register returns the one-time
// client credentials to the CALLER (shown once) and is deliberately never cached.
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteOAuthApp, fetchOAuthApps, registerOAuthApp } from "../api";
import { settingsDeveloperKeys } from "../keys";
import type { OAuthAppCredentials, OAuthAppsFeed } from "../types";

export function useOAuthApps() {
  const qc = useQueryClient();
  const key = settingsDeveloperKeys.oauthApps();
  const query = useQuery<OAuthAppsFeed>({ queryKey: key, queryFn: fetchOAuthApps });

  const refreshIfOk = ({ ok }: { ok: boolean }) => {
    if (ok) void qc.invalidateQueries({ queryKey: key });
  };

  const register = useMutation({
    mutationFn: (vars: { name: string; redirectUris: string[] }) =>
      registerOAuthApp(vars.name, vars.redirectUris),
    onSuccess: refreshIfOk,
  });
  const remove = useMutation({ mutationFn: deleteOAuthApp, onSuccess: refreshIfOk });

  return {
    feed: query.data ?? null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load OAuth apps"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
    register: (name: string, redirectUris: string[]): Promise<OAuthAppCredentials> =>
      register.mutateAsync({ name, redirectUris }),
    remove: async (id: string): Promise<boolean> => (await remove.mutateAsync(id)).ok,
  };
}
