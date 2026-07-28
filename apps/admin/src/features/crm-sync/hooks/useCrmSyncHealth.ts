// useCrmSyncHealth.ts — loads the fleet-wide CRM connection health (GET /admin/crm/sync-health) with
// loading/error state and a `reload`. Presentation state only; the typed fetch lives in api.ts.
//
// NOT polled. Every request writes a cross-tenant audit row, so a background refresh would generate a
// steady stream of audit entries nobody initiated — the operator reloads deliberately instead.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchCrmSyncHealth } from "../api";
import type { StaffCrmConnection } from "../types";

export function useCrmSyncHealth() {
  const [connections, setConnections] = useState<StaffCrmConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setConnections(await fetchCrmSyncHealth());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load CRM sync health");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { connections, error, loading, reload };
}
