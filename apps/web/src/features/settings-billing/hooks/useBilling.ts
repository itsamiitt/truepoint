// useBilling.ts — view state for the billing hub's Plan + Credits tabs: loads the credit-pool balance and the
// tenant plan envelope together, exposing one loading/error pair and a `reload`, plus a topUp() that begins a
// Stripe checkout (or reports it isn't wired). The Usage tab owns its own paginated/filtered data
// (useUsageHistory). Presentation state only; metering + credit accounting happen server-side (07 §3).
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchBalance, fetchTenantPlan, startCheckout } from "../api";
import type { TenantPlan } from "../types";

export function useBilling() {
  const [balance, setBalance] = useState<number | null>(null);
  const [plan, setPlan] = useState<TenantPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [b, p] = await Promise.all([fetchBalance(), fetchTenantPlan()]);
      setBalance(b);
      setPlan(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load billing");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Begin a top-up. Returns the Stripe checkout URL, or null when checkout isn't wired (404/501). */
  const topUp = useCallback(async (pack: string): Promise<string | null> => {
    const { available, checkoutUrl } = await startCheckout(pack);
    return available ? (checkoutUrl ?? null) : null;
  }, []);

  return { balance, plan, error, loading, reload, topUp };
}
