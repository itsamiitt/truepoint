// useIdentity.ts — loads + mutates the Tenant ▸ Security ▸ Domains & SCIM surface (domain claiming + SCIM
// tokens) with loading/error/reload + an explicit `forbidden` flag for callers without the security_admin/
// owner org role (the API returns 403). Mirrors useAuthPolicy. Mutations re-fetch the affected list so the
// table reflects the server (never optimistic — the IDs/timestamps are server-assigned).
"use client";

import type { DomainView, ScimTokenCreated, ScimTokenView } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import {
  claimDomain,
  createScimToken,
  fetchDomains,
  fetchScimTokens,
  revokeScimToken,
  verifyDomain,
} from "../identityApi";

export function useIdentity() {
  const [domains, setDomains] = useState<DomainView[]>([]);
  const [tokens, setTokens] = useState<ScimTokenView[]>([]);
  const [forbidden, setForbidden] = useState(false);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const [d, t] = await Promise.all([fetchDomains(), fetchScimTokens()]);
      setForbidden(d.forbidden || t.forbidden);
      setAvailable(d.available && t.available);
      setDomains(d.domains);
      setTokens(t.tokens);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load domains & SCIM");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const reloadDomains = useCallback(async () => {
    const d = await fetchDomains();
    setDomains(d.domains);
  }, []);

  const reloadTokens = useCallback(async () => {
    const t = await fetchScimTokens();
    setTokens(t.tokens);
  }, []);

  const claim = useCallback(
    async (domain: string): Promise<void> => {
      await claimDomain(domain);
      await reloadDomains();
    },
    [reloadDomains],
  );

  const verify = useCallback(
    async (id: string): Promise<void> => {
      await verifyDomain(id);
      await reloadDomains();
    },
    [reloadDomains],
  );

  // Returns the one-time plaintext so the panel can surface it once; the list is then re-fetched (masked).
  const createToken = useCallback(
    async (name: string): Promise<ScimTokenCreated> => {
      const created = await createScimToken(name);
      await reloadTokens();
      return created;
    },
    [reloadTokens],
  );

  const revokeToken = useCallback(
    async (id: string): Promise<void> => {
      await revokeScimToken(id);
      await reloadTokens();
    },
    [reloadTokens],
  );

  return {
    domains,
    tokens,
    forbidden,
    available,
    error,
    loading,
    reload,
    claim,
    verify,
    createToken,
    revokeToken,
  };
}
