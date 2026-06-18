// useTenants.ts — loads the cross-tenant directory (GET /admin/tenants) with loading/error state and a
// `reload`. Presentation state only; the typed fetch lives in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchTenants } from "../api";
import type { TenantRow } from "../types";

export function useTenants() {
  const [tenants, setTenants] = useState<TenantRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTenants(await fetchTenants());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tenants");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { tenants, error, loading, reload };
}
