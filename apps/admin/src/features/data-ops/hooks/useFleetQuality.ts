// useFleetQuality.ts — loads the cross-tenant fleet data-quality view (GET /admin/data/quality/snapshots) with
// loading/error state and a `reload` (the admin app's useState convention — NO TanStack). Presentation state
// only; the typed fetch lives in api.ts and the shape comes from the slice's types.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchFleetQuality } from "../api";
import type { FleetQualityRow } from "../types";

export function useFleetQuality() {
  const [snapshots, setSnapshots] = useState<FleetQualityRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshots(await fetchFleetQuality());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the fleet quality view");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { snapshots, error, loading, reload };
}
