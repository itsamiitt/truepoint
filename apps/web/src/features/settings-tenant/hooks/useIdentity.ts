// useIdentity.ts — the Tenant ▸ Security ▸ Domains & SCIM surface (domain claiming + SCIM tokens), with an
// explicit `forbidden` flag for callers without the security_admin/owner org role (the API returns 403).
// Mutations re-read the affected list from the server rather than patching — never optimistic, because the
// IDs, verification state and timestamps are all server-assigned.
//
// Domains and tokens are SEPARATE queries. The previous version loaded them together but then had two bespoke
// partial-reload helpers so a domain action would not re-fetch the tokens; as two keys that falls out for
// free, and a slow token list no longer delays rendering the domains.
"use client";

import type { ScimTokenCreated } from "@leadwolf/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  claimDomain,
  createScimToken,
  fetchDomains,
  fetchScimTokens,
  revokeScimToken,
  verifyDomain,
} from "../identityApi";
import { settingsTenantKeys } from "../keys";

export function useIdentity() {
  const qc = useQueryClient();
  const domainsKey = settingsTenantKeys.domains();
  const tokensKey = settingsTenantKeys.scimTokens();

  const domains = useQuery({ queryKey: domainsKey, queryFn: fetchDomains });
  const tokens = useQuery({ queryKey: tokensKey, queryFn: fetchScimTokens });

  const refreshDomains = () => {
    void qc.invalidateQueries({ queryKey: domainsKey });
  };
  const refreshTokens = () => {
    void qc.invalidateQueries({ queryKey: tokensKey });
  };

  const claim = useMutation({ mutationFn: claimDomain, onSuccess: refreshDomains });
  const verify = useMutation({ mutationFn: verifyDomain, onSuccess: refreshDomains });
  // Returns the one-time plaintext so the panel can surface it once; the LIST is then re-read masked. The
  // plaintext itself is never written to the cache.
  const createToken = useMutation({ mutationFn: createScimToken, onSuccess: refreshTokens });
  const revokeToken = useMutation({ mutationFn: revokeScimToken, onSuccess: refreshTokens });

  const error = domains.error ?? tokens.error;

  return {
    domains: domains.data?.domains ?? [],
    tokens: tokens.data?.tokens ?? [],
    // Either endpoint refusing means the surface is forbidden; either being unbuilt means it is unavailable.
    forbidden: (domains.data?.forbidden ?? false) || (tokens.data?.forbidden ?? false),
    available: (domains.data?.available ?? true) && (tokens.data?.available ?? true),
    error: error
      ? error instanceof Error
        ? error.message
        : "Failed to load domains & SCIM"
      : null,
    loading: domains.isPending || tokens.isPending,
    reload: () => {
      void domains.refetch();
      void tokens.refetch();
    },
    claim: async (domain: string): Promise<void> => {
      await claim.mutateAsync(domain);
    },
    verify: async (id: string): Promise<void> => {
      await verify.mutateAsync(id);
    },
    createToken: (name: string): Promise<ScimTokenCreated> => createToken.mutateAsync(name),
    revokeToken: async (id: string): Promise<void> => {
      await revokeToken.mutateAsync(id);
    },
  };
}
