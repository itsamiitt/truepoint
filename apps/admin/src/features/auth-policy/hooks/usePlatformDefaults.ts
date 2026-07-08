// usePlatformDefaults.ts — client loader for the platform-default auth policy (the app's useState/useEffect
// convention; no TanStack). Returns the rows plus loading/error and a reload() the page uses after a mutation.
"use client";

import { useCallback, useEffect, useState } from "react";
import { type PlatformDefault, listPlatformDefaults } from "../api";

export function usePlatformDefaults(): {
  rows: PlatformDefault[];
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
} {
  const [rows, setRows] = useState<PlatformDefault[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listPlatformDefaults());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load platform auth defaults");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { rows, error, loading, reload };
}
