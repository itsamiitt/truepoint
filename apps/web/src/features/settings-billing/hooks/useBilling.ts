// useBilling.ts — view state for the billing surface: loads the credit-pool balance, the usage history, and the
// tenant plan envelope together, exposing one loading/error pair and a `reload`, plus a topUp() that begins a
// Stripe checkout (or reports it isn't wired). Presentation state only; metering + credit accounting happen
// server-side (07 §3).
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchBalance, fetchTenantPlan, fetchUsage, startCheckout } from "../api";
import type { TenantPlan, UsageReveal } from "../types";

export function useBilling(limit = 100) {
  const [balance, setBalance] = useState<number | null>(null);
  const [usage, setUsage] = useState<UsageReveal[]>([]);
  const [plan, setPlan] = useState<TenantPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [b, u, p] = await Promise.all([fetchBalance(), fetchUsage(limit), fetchTenantPlan()]);
      setBalance(b);
      setUsage(u);
      setPlan(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load billing");
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Begin a top-up. Returns the Stripe checkout URL, or null when checkout isn't wired (404/501). */
  const topUp = useCallback(async (pack: string): Promise<string | null> => {
    const { available, checkoutUrl } = await startCheckout(pack);
    return available ? (checkoutUrl ?? null) : null;
  }, []);

  return { balance, usage, plan, error, loading, reload, topUp };
}
