// useBilling.ts — the billing hub's Plan + Credits header: the credit-pool balance and the tenant plan
// envelope, loaded together behind one loading/error pair, plus a topUp() that begins a Stripe checkout (or
// reports it is not wired). The Usage tab owns its own paginated/filtered data (useUsageHistory).
// Presentation state only; metering and credit accounting happen server-side (07 §3).
//
// topUp is a mutation with no cache effect on purpose: it hands back a checkout URL and the balance only
// changes once Stripe calls back, so invalidating here would re-read a number that has not moved yet.
"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { fetchBalance, fetchTenantPlan, startCheckout } from "../api";
import { settingsBillingKeys } from "../keys";

export function useBilling() {
  const query = useQuery({
    queryKey: settingsBillingKeys.overview(),
    queryFn: async () => {
      const [balance, plan] = await Promise.all([fetchBalance(), fetchTenantPlan()]);
      return { balance, plan };
    },
  });

  const topUp = useMutation({ mutationFn: startCheckout });

  return {
    balance: query.data?.balance ?? null,
    plan: query.data?.plan ?? null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load billing"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
    /** Begin a top-up. Returns the Stripe checkout URL, or null when checkout is not wired (404/501). */
    topUp: async (pack: string): Promise<string | null> => {
      const { available, checkoutUrl } = await topUp.mutateAsync(pack);
      return available ? (checkoutUrl ?? null) : null;
    },
  };
}
