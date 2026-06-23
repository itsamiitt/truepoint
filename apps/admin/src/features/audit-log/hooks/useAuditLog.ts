// useAuditLog.ts — loads the recent platform audit entries (GET /admin/audit-log) with loading/error state
// and a `reload`. Presentation state only; the typed fetch lives in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchAuditLog } from "../api";
import type { PlatformAuditEntry } from "../types";

export function useAuditLog() {
  const [entries, setEntries] = useState<PlatformAuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEntries(await fetchAuditLog());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load audit log");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { entries, error, loading, reload };
}
