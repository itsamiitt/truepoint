// useAutoEnrichPolicy.ts — loads the workspace auto-enrich policy (GET /settings/auto-enrich) with
// loading/error + reload, and exposes save(). Presentation state only; typed fetches live in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { type AutoEnrichPolicyPatch, fetchAutoEnrichPolicy, saveAutoEnrichPolicy } from "../api";
import type { AutoEnrichPolicy } from "../types";

export function useAutoEnrichPolicy() {
  const [data, setData] = useState<AutoEnrichPolicy | null>(null);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const policy = await fetchAutoEnrichPolicy();
      setData(policy);
      setAvailable(policy != null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the auto-enrich policy");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Save the policy. Returns true when persisted; false when the route isn't built yet. */
  const save = useCallback(async (patch: AutoEnrichPolicyPatch): Promise<boolean> => {
    const saved = await saveAutoEnrichPolicy(patch);
    if (saved) setData(saved);
    return saved != null;
  }, []);

  return { data, available, error, loading, reload, save };
}
