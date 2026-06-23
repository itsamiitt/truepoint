// useAuthPolicy.ts — loads the tenant auth policy (Tenant ▸ Security & access) with loading/error/reload +
// an explicit `forbidden` flag for callers without the security_admin/owner org role (the API returns 403).
// The endpoint always returns a policy (the platform default when unset), so there is no "unavailable" state.
"use client";

import type { AuthPolicy } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import { fetchAuthPolicy, saveAuthPolicy } from "../api";

export function useAuthPolicy() {
  const [policy, setPolicy] = useState<AuthPolicy | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const res = await fetchAuthPolicy();
      setForbidden(res.forbidden);
      setPolicy(res.policy);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the auth policy");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(async (next: AuthPolicy): Promise<boolean> => {
    const { ok } = await saveAuthPolicy(next);
    return ok;
  }, []);

  return { policy, forbidden, error, loading, reload, save };
}
