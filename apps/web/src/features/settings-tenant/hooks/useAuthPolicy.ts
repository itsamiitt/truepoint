// useAuthPolicy.ts — the tenant auth policy (Tenant ▸ Security & access), with an explicit `forbidden` flag
// for callers without the security_admin/owner org role (the API returns 403). The endpoint always returns a
// policy (the platform default when unset), so there is no "unavailable" state.
//
// A successful save writes the policy straight into the cache: it is the value the server just accepted, so a
// refetch to learn it would be a round trip for something already known.
"use client";

import type { AuthPolicy } from "@leadwolf/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAuthPolicy, saveAuthPolicy } from "../api";
import { settingsTenantKeys } from "../keys";

export function useAuthPolicy() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: settingsTenantKeys.authPolicy(),
    queryFn: fetchAuthPolicy,
  });

  const save = useMutation({
    mutationFn: async (next: AuthPolicy) => {
      const { ok } = await saveAuthPolicy(next);
      return { ok, next };
    },
    onSuccess: ({ ok, next }) => {
      if (ok) {
        qc.setQueryData(settingsTenantKeys.authPolicy(), (old: unknown) => ({
          ...(old as { forbidden: boolean }),
          policy: next,
        }));
      }
    },
  });

  return {
    policy: query.data?.policy ?? null,
    forbidden: query.data?.forbidden ?? false,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load the auth policy"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
    save: async (next: AuthPolicy): Promise<boolean> => (await save.mutateAsync(next)).ok,
  };
}
