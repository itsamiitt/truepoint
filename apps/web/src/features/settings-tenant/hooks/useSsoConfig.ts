// useSsoConfig.ts — loads the tenant SSO config (Tenant ▸ Single sign-on) with loading/error/reload + an
// explicit `forbidden` flag for callers without the security_admin/owner org role (the API returns 403).
// `config` is null when the org has not configured SSO yet — the panel renders an unconfigured default form.
"use client";

import type { SsoConfigUpdate, SsoConfigView } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import { fetchSsoConfig, saveSsoConfig } from "../ssoApi";

export function useSsoConfig() {
  const [config, setConfig] = useState<SsoConfigView | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const res = await fetchSsoConfig();
      setForbidden(res.forbidden);
      setConfig(res.config);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the SSO configuration");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (next: SsoConfigUpdate): Promise<boolean> => {
      const { ok } = await saveSsoConfig(next);
      if (ok) await reload(); // re-read the masked view (hasClientSecret) after a successful save
      return ok;
    },
    [reload],
  );

  return { config, forbidden, error, loading, reload, save };
}
