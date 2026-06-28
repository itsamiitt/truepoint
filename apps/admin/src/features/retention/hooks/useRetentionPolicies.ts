// useRetentionPolicies.ts — loads the global retention-policy list (GET /admin/retention-policies) with
// loading/error/reload state (the admin app's useState convention — NO TanStack). Presentation state only;
// the typed fetch lives in api.ts and the shapes come from @leadwolf/types.
"use client";

import type { RetentionPolicy } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import { listRetentionPolicies } from "../api";

export function useRetentionPolicies() {
  const [policies, setPolicies] = useState<RetentionPolicy[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPolicies(await listRetentionPolicies());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load retention policies");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { policies, error, loading, reload };
}
