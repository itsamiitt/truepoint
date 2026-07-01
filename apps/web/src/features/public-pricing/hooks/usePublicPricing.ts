// usePublicPricing.ts — view state for the public pricing page: loads the active plan tiers + credit packs
// together, exposing one loading/error pair and a reload. No auth, no tenant — purely the public catalog
// (ADR-0012 transparent self-serve). Presentation state only.
"use client";

import type { PublicCreditPack, PublicPlan } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import { fetchPublicPacks, fetchPublicPlans } from "../api";

export function usePublicPricing() {
  const [plans, setPlans] = useState<PublicPlan[]>([]);
  const [packs, setPacks] = useState<PublicCreditPack[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const [pl, pk] = await Promise.all([fetchPublicPlans(signal), fetchPublicPacks(signal)]);
      setPlans(pl);
      setPacks(pk);
    } catch (e) {
      if (signal?.aborted) return;
      setError(e instanceof Error ? e.message : "Failed to load pricing");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  return { plans, packs, error, loading, reload };
}
