// useSsoConfig.ts — the tenant SSO configuration, with an explicit `forbidden` flag for callers without the
// required org role (the API returns 403).
//
// A successful save INVALIDATES rather than patching: the server returns a masked view (hasClientSecret rather
// than the secret), so the only correct post-save value is the one the server computes.
"use client";

import type { SsoConfigUpdate } from "@leadwolf/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { settingsTenantKeys } from "../keys";
import { fetchSsoConfig, saveSsoConfig } from "../ssoApi";

export function useSsoConfig() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: settingsTenantKeys.ssoConfig(), queryFn: fetchSsoConfig });

  const save = useMutation({
    mutationFn: (next: SsoConfigUpdate) => saveSsoConfig(next),
    onSuccess: ({ ok }) => {
      if (ok) void qc.invalidateQueries({ queryKey: settingsTenantKeys.ssoConfig() });
    },
  });

  return {
    config: query.data?.config ?? null,
    forbidden: query.data?.forbidden ?? false,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load the SSO configuration"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
    save: async (next: SsoConfigUpdate): Promise<boolean> => (await save.mutateAsync(next)).ok,
  };
}
