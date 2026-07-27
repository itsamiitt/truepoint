// usePublicPricing.ts — the public pricing page: the active plan tiers + credit packs loaded together behind
// one loading/error pair. No auth, no tenant — purely the public catalog (ADR-0012 transparent self-serve).
"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchPublicPacks, fetchPublicPlans } from "../api";
import { publicPricingKeys } from "../keys";

export function usePublicPricing() {
  const query = useQuery({
    queryKey: publicPricingKeys.catalog(),
    // RQ owns the AbortSignal, which is what the hand-rolled controller and its three `signal.aborted` guards
    // were for — an aborted fetch is a cancellation, not a state update to suppress after the fact.
    queryFn: async ({ signal }) => {
      const [plans, packs] = await Promise.all([
        fetchPublicPlans(signal),
        fetchPublicPacks(signal),
      ]);
      return { plans, packs };
    },
  });

  return {
    plans: query.data?.plans ?? [],
    packs: query.data?.packs ?? [],
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load pricing"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
  };
}
